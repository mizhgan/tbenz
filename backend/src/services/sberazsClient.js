const axios = require('axios');
const { sberazsApiBaseUrl, proxyRequestTimeoutMs } = require('../config/env');
const Proxy = require('../models/Proxy');
const proxyService = require('./proxyService');
const browserFetchService = require('./browserFetchService');
const logger = require('../utils/logger');

const MAX_PROXY_ATTEMPTS = 5;

function bboxParams({ minLat, maxLat, minLon, maxLon }) {
  return { bbox: `${minLon},${minLat},${maxLon},${maxLat}` };
}

function buildUrl(bbox) {
  return axios.getUri({ baseURL: sberazsApiBaseUrl, url: '', params: bboxParams(bbox) });
}

// See tbankClient.js's buildRequestUrl for why this is exposed on its own
// rather than only ever derived from a successful response.
function buildRequestUrl(bbox) {
  return buildUrl(bbox);
}

// A plain HTTP client (even with a browser-shaped User-Agent, with or
// without a proxy - both tried and confirmed blocked identically) always
// gets served sberazs.ru's anti-bot JS-challenge page instead of the real
// response - see browserFetchService.js's doc comment for what that
// challenge actually does and why a real (headless) browser is the fix,
// not a smarter HTTP client.
async function requestOnce(proxy, bbox) {
  const url = buildUrl(bbox);
  const proxyOption = proxy ? proxyService.buildPlaywrightProxyOption(proxy) : undefined;
  // Russian banks have been migrating to the national root CA (see
  // alfabankClient.js, which hit this live) - sberazs.ru hasn't yet as of
  // this writing, but pre-empting it here is cheap: scoped to this fetch's
  // own short-lived browser context, not every page this shared Chromium
  // instance ever opens.
  return browserFetchService.fetchJsonThroughBrowser(url, {
    proxy: proxyOption,
    timeoutMs: proxyRequestTimeoutMs,
    ignoreHTTPSErrors: true,
  });
}

/**
 * Fetches gas stations for a bounding box from sberazs.ru. Bbox filtering is
 * genuinely server-side (verified live: a far-away bbox returns zero
 * stations, a tight one returns a proper subset) - a single comma-joined
 * `bbox=minLon,minLat,maxLon,maxLat` query param, unlike gdebenz's four
 * separate lat1/lon1/lat2/lon2 params.
 *
 * Routes through the same admin-configured proxy pool as tbankClient.js
 * when a *browser-compatible* proxy is active, via a headless browser
 * instead of a plain HTTP client (see requestOnce above and
 * browserFetchService.js). Records outcomes under its own 'sberazs'
 * sourceKey (see proxyService.recordSuccess/recordFailure) rather than
 * tbank's - this source's anti-bot block has nothing to do with which IP
 * it's coming from (confirmed live: identical through every proxy and
 * direct), so letting those failures count against tbank's own
 * consecutiveFailures would have risked auto-disabling a proxy that's
 * perfectly healthy for tbank, for a block rotating IPs can't route around
 * anyway.
 *
 * Only ever picks from proxyService.isBrowserCompatible proxies (http/
 * https, or SOCKS5 *without* credentials) - Chromium can't authenticate to
 * a SOCKS5 proxy at all, confirmed live that this app's entire pool is
 * SOCKS5-with-credentials in practice, which used to mean every single
 * attempt failed the exact same way before falling through to direct
 * anyway. Skipping incompatible proxies up front instead of discovering
 * that per-attempt means a pool that's 100% incompatible goes straight to
 * a direct fetch with no wasted attempts/warnings at all, while a pool
 * that's *partially* compatible still gets real proxy rotation for the
 * types that work.
 *
 * Falls back to a direct (no-proxy) attempt if every compatible-proxy
 * attempt fails too (or none are compatible/configured) - a direct browser
 * fetch is what actually gets past sberazs's block in the first place
 * (proxying was never what solved this specific check), so this fallback
 * is what keeps sberazs working regardless of what's in the pool.
 */
async function fetchStations(bbox) {
  const requestUrl = buildRequestUrl(bbox);
  const activeProxies = await Proxy.find({ active: true });
  const compatibleCount = activeProxies.filter(proxyService.isBrowserCompatible).length;

  if (compatibleCount === 0) {
    const data = await requestOnce(null, bbox);
    return { data, requestUrl };
  }

  const triedIds = [];
  let lastErr;
  const attempts = Math.min(compatibleCount, MAX_PROXY_ATTEMPTS);

  for (let i = 0; i < attempts; i += 1) {
    const proxy = await proxyService.pickRandomActiveProxy(triedIds, { browserCompatible: true });
    if (!proxy) break;
    triedIds.push(proxy._id);

    try {
      const data = await requestOnce(proxy, bbox);
      await proxyService.recordSuccess(proxy._id, 'sberazs');
      return { data, requestUrl };
    } catch (err) {
      lastErr = err;
      logger.warn(`Proxy ${proxy.host}:${proxy.port} request failed (sberazs): ${err.message}`);
      await proxyService.recordFailure(proxy._id, err, 'sberazs');
    }
  }

  try {
    const data = await requestOnce(null, bbox);
    return { data, requestUrl };
  } catch (directErr) {
    throw lastErr || directErr;
  }
}

module.exports = { fetchStations, buildRequestUrl };
