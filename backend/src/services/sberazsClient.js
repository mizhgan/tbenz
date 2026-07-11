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
  return browserFetchService.fetchJsonThroughBrowser(url, { proxy: proxyOption, timeoutMs: proxyRequestTimeoutMs });
}

/**
 * Fetches gas stations for a bounding box from sberazs.ru. Bbox filtering is
 * genuinely server-side (verified live: a far-away bbox returns zero
 * stations, a tight one returns a proper subset) - a single comma-joined
 * `bbox=minLon,minLat,maxLon,maxLat` query param, unlike gdebenz's four
 * separate lat1/lon1/lat2/lon2 params.
 *
 * Routes through the same admin-configured proxy pool as tbankClient.js
 * when any proxy is active, via a headless browser instead of a plain HTTP
 * client (see requestOnce above and browserFetchService.js). Records
 * outcomes under its own 'sberazs' sourceKey (see
 * proxyService.recordSuccess/recordFailure) rather than tbank's - this
 * source's anti-bot block has nothing to do with which IP it's coming from
 * (confirmed live: identical through every proxy and direct), so letting
 * those failures count against tbank's own consecutiveFailures would have
 * risked auto-disabling a proxy that's perfectly healthy for tbank, for a
 * block rotating IPs can't route around anyway.
 *
 * Falls back to a direct (no-proxy) attempt if every proxy attempt fails,
 * not just when none are configured - confirmed live that this app's
 * SOCKS5-with-credentials proxies (its only proxy type in practice) simply
 * can't be used at all through a headless browser (Chromium has no support
 * for authenticating to a SOCKS5 proxy, a hard limitation, not a config
 * problem or a transient failure worth retrying against). Since a direct
 * browser fetch is what actually gets past sberazs's block in the first
 * place (proxying was never what solved this specific check - see above),
 * this fallback is what keeps sberazs working at all for as long as the
 * configured pool is exclusively that proxy type, without having to rip out
 * proxy support entirely on the chance a compatible (HTTP/HTTPS, or
 * unauthenticated SOCKS5) proxy gets added later.
 */
async function fetchStations(bbox) {
  const requestUrl = buildRequestUrl(bbox);
  const activeProxyCount = await Proxy.countDocuments({ active: true });

  if (activeProxyCount === 0) {
    const data = await requestOnce(null, bbox);
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
