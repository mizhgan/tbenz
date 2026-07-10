const axios = require('axios');
const { sberazsApiBaseUrl, proxyRequestTimeoutMs } = require('../config/env');
const Proxy = require('../models/Proxy');
const proxyService = require('./proxyService');
const logger = require('../utils/logger');

// Same browser User-Agent trick as gdebenzClient.js - verified live: a
// default axios/curl User-Agent gets served an anti-bot JS-challenge page
// (redirect + cookie-setting script) instead of JSON; a browser-shaped one
// goes straight through with no cookies/challenge needed at all. Kept even
// though it turned out not to be sufficient on its own (see fetchStations'
// doc comment below) - it still helps, just not always.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const MAX_PROXY_ATTEMPTS = 5;

function buildClient(agent) {
  return axios.create({
    baseURL: sberazsApiBaseUrl,
    timeout: proxyRequestTimeoutMs,
    httpAgent: agent || undefined,
    httpsAgent: agent || undefined,
    proxy: agent ? false : undefined,
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
  });
}

function bboxParams({ minLat, maxLat, minLon, maxLon }) {
  return { bbox: `${minLon},${minLat},${maxLon},${maxLat}` };
}

// See tbankClient.js's buildRequestUrl for why this is exposed on its own
// rather than only ever derived from a successful response.
function buildRequestUrl(bbox) {
  return buildClient(null).getUri({ url: '', params: bboxParams(bbox) });
}

// A block/rate-limit here shows up as a 200 OK carrying an HTML challenge
// page, not an HTTP error - axios never throws for it, so left unchecked
// every attempt would look like a "success" that happens to return an empty
// station list (see extractStationsArray's `typeof payload !== 'object'`
// fallback), indistinguishable from a region that genuinely has none.
// sberazs's real payload is always a JSON object (see sberazsParser.js's doc
// comment); a string body is the one signal available that this attempt was
// actually blocked, so it's promoted to a thrown error here - which, for a
// proxied attempt, is exactly what makes the retry loop below move on to a
// different proxy instead of quietly accepting the challenge page as data.
async function requestOnce(agent, params) {
  const response = await buildClient(agent).get('', { params });
  if (typeof response.data === 'string') {
    throw new Error('sberazs returned a non-JSON response (likely an anti-bot block/challenge page)');
  }
  return response.data;
}

/**
 * Fetches gas stations for a bounding box from sberazs.ru. Bbox filtering is
 * genuinely server-side (verified live: a far-away bbox returns zero
 * stations, a tight one returns a proper subset) - a single comma-joined
 * `bbox=minLon,minLat,maxLon,maxLat` query param, unlike gdebenz's four
 * separate lat1/lon1/lat2/lon2 params.
 *
 * Routes through the same admin-configured proxy pool as tbankClient.js
 * when any proxy is active (added after observing this source get blocked
 * even with a browser User-Agent - see requestOnce above); with no active
 * proxies configured, requests go out directly, same as before this
 * existed. Records outcomes under its own 'sberazs' sourceKey (see
 * proxyService.recordSuccess/recordFailure) rather than tbank's - confirmed
 * live that this source gets blocked identically through every proxy *and*
 * direct, so proxy rotation alone doesn't actually fix it; letting those
 * failures count against tbank's own consecutiveFailures would have risked
 * auto-disabling a proxy that's perfectly healthy for tbank, for a block
 * rotating IPs can't route around anyway.
 */
async function fetchStations(bbox) {
  const params = bboxParams(bbox);
  const requestUrl = buildRequestUrl(bbox);
  const activeProxyCount = await Proxy.countDocuments({ active: true });

  if (activeProxyCount === 0) {
    const data = await requestOnce(null, params);
    return { data, requestUrl };
  }

  const triedIds = [];
  let lastErr;
  const attempts = Math.min(activeProxyCount, MAX_PROXY_ATTEMPTS);

  for (let i = 0; i < attempts; i += 1) {
    const proxy = await proxyService.pickRandomActiveProxy(triedIds);
    if (!proxy) break;
    triedIds.push(proxy._id);

    try {
      const agent = proxyService.buildAgent(proxy);
      const data = await requestOnce(agent, params);
      await proxyService.recordSuccess(proxy._id, 'sberazs');
      return { data, requestUrl };
    } catch (err) {
      lastErr = err;
      logger.warn(`Proxy ${proxy.host}:${proxy.port} request failed (sberazs): ${err.message}`);
      await proxyService.recordFailure(proxy._id, err, 'sberazs');
    }
  }

  throw lastErr || new Error('No active proxies were available to complete the request');
}

module.exports = { fetchStations, buildRequestUrl };
