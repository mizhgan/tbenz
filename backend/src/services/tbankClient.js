const https = require('https');
const axios = require('axios');
const { tbankApiBaseUrl, proxyRequestTimeoutMs } = require('../config/env');
const Proxy = require('../models/Proxy');
const proxyService = require('./proxyService');
const logger = require('../utils/logger');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const MAX_PROXY_ATTEMPTS = 5;

// Russian banks have been migrating to the national root CA (see
// alfabankClient.js, which hit this live) - toplivo.tbank.ru hasn't yet as
// of this writing, but pre-empting it here is cheap and this is scoped to
// this client's own agents, not process-wide.
const INSECURE_TLS = { rejectUnauthorized: false };
const directHttpsAgent = new https.Agent(INSECURE_TLS);

function buildClient(agent) {
  return axios.create({
    baseURL: tbankApiBaseUrl,
    timeout: proxyRequestTimeoutMs,
    httpAgent: agent || undefined,
    httpsAgent: agent || directHttpsAgent,
    proxy: agent ? false : undefined,
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
  });
}

// The actual URL a poll for this bbox hits, independent of whether the
// request goes out directly or through a proxy (a proxy changes the
// outbound TCP path, not the target URL) - callable on its own so admins can
// see/copy it from the Regions page even for a request that's currently
// failing (see ingestService.js's catch path, which has no response to pull
// a URL out of).
function buildRequestUrl(params) {
  return buildClient(null).getUri({ url: '', params });
}

/**
 * Fetches gas stations / recent transactions for a bounding box from
 * toplivo.tbank.ru. The exact response shape hasn't been verified against a
 * live call (network access to the host is unavailable in this dev
 * environment), so callers must treat the payload defensively - see
 * ingestService.extractStationsArray / parseStation.
 *
 * If admins have configured active proxies, each request goes through a
 * randomly chosen one; a failing proxy is marked (and auto-disabled past the
 * configured threshold) and a different active proxy is tried next, up to
 * MAX_PROXY_ATTEMPTS. With no active proxies configured, requests go out
 * directly, same as before this feature existed.
 */
async function fetchStations({ minLat, maxLat, minLon, maxLon }) {
  const params = { minLat, maxLat, minLon, maxLon };
  const requestUrl = buildRequestUrl(params);
  const activeProxyCount = await Proxy.countDocuments({ active: true });

  if (activeProxyCount === 0) {
    const response = await buildClient(null).get('', { params });
    return { data: response.data, requestUrl };
  }

  const triedIds = [];
  let lastErr;
  const attempts = Math.min(activeProxyCount, MAX_PROXY_ATTEMPTS);

  for (let i = 0; i < attempts; i += 1) {
    const proxy = await proxyService.pickRandomActiveProxy(triedIds);
    if (!proxy) break;
    triedIds.push(proxy._id);

    try {
      const agent = proxyService.buildAgent(proxy, INSECURE_TLS);
      const response = await buildClient(agent).get('', { params });
      await proxyService.recordSuccess(proxy._id);
      return { data: response.data, requestUrl };
    } catch (err) {
      lastErr = err;
      logger.warn(`Proxy ${proxy.host}:${proxy.port} request failed: ${err.message}`);
      await proxyService.recordFailure(proxy._id, err);
    }
  }

  throw lastErr || new Error('No active proxies were available to complete the request');
}

module.exports = { fetchStations, buildRequestUrl };
