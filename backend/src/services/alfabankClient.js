const https = require('https');
const axios = require('axios');
const { alfabankApiBaseUrl, proxyRequestTimeoutMs } = require('../config/env');
const { memoizeAsync } = require('../utils/cache');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// alfabank.ru now serves a Russian national root CA cert that Node's default
// trust store doesn't carry, so every request fails TLS verification
// (`self-signed certificate in certificate chain`) before it ever reaches
// the anti-bot redirect loop below. There's no legitimate CA bundle to add
// here, so skip verification for this client only - scoped to this one
// httpsAgent, not process-wide (no NODE_TLS_REJECT_UNAUTHORIZED).
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Verified live: a plain request gets a 307 back to the exact same URL,
// minting a fresh `spid`/`spsc` anti-bot cookie pair each hop
// (servicepipe.ru, visible on alfabank.ru's own pages) - it only actually
// returns data once those cookies have been sent back on a follow-up
// request a handful of times. No JS execution/challenge required (unlike
// sberazs's real anti-bot block - see sberazsClient.js): a plain
// `curl -c jar -b jar -L` reproduces this exactly, so this loops the same
// URL manually instead, since axios (like curl without a cookie jar)
// doesn't carry cookies across its own redirect handling at all.
const MAX_REDIRECT_HOPS = 8;

function mergeCookies(jar, setCookieHeaders) {
  if (!setCookieHeaders) return jar;
  for (const line of setCookieHeaders) {
    const pair = line.split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return jar;
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function fetchRaw() {
  const jar = new Map();
  let lastStatus;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
    const response = await axios.get(alfabankApiBaseUrl, {
      timeout: proxyRequestTimeoutMs,
      maxRedirects: 0,
      validateStatus: (status) => status === 200 || status === 307,
      httpsAgent,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        Referer: 'https://alfabank.ru/azs',
        Cookie: cookieHeader(jar),
      },
    });
    lastStatus = response.status;
    if (response.status === 200) return response.data;
    mergeCookies(jar, response.headers['set-cookie']);
  }
  throw new Error(`alfabank: gave up after ${MAX_REDIRECT_HOPS} redirect hops without a 200 (last status ${lastStatus})`);
}

// alfabank has no bbox param at all - one request always returns every
// station in Russia (confirmed live: ~16.5k stations, ~18MB JSON) - cached
// briefly so polling this region (and any future second region on the same
// short interval) doesn't redownload the whole country every tick.
const fetchRawCached = memoizeAsync(fetchRaw, { ttlMs: 5 * 60 * 1000, keyFn: () => 'all' });

// See tbankClient.js's buildRequestUrl for why this is exposed on its own
// rather than only ever derived from a successful response. Takes `bbox`
// only to match every other source's fetchStations/buildRequestUrl shape -
// unused, since alfabank's own request never varies by bbox.
function buildRequestUrl() {
  return alfabankApiBaseUrl;
}

function inBbox(rawStation, bbox) {
  const location = rawStation?.address?.location;
  const lat = Number(location?.latitude);
  const lon = Number(location?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return lat >= bbox.minLat && lat <= bbox.maxLat && lon >= bbox.minLon && lon <= bbox.maxLon;
}

/**
 * Fetches (the cached, whole-country) alfabank station list and filters it
 * down to `bbox` client-side, since the source itself has no bbox param -
 * unlike tbank/gdebenz/sberazs, `data` here is already the region-scoped
 * subset by the time it reaches secondarySourceIngestService.js, so
 * capRawResponse (Region.sourcePollStatus) stores a normal-sized payload
 * rather than the full country.
 */
async function fetchStations(bbox) {
  const all = await fetchRawCached();
  const list = Array.isArray(all) ? all : [];
  return { data: list.filter((raw) => inBbox(raw, bbox)), requestUrl: buildRequestUrl() };
}

module.exports = { fetchStations, buildRequestUrl };
