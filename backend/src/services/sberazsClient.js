const axios = require('axios');
const { sberazsApiBaseUrl, proxyRequestTimeoutMs } = require('../config/env');

// Same browser User-Agent trick as gdebenzClient.js - verified live: a
// default axios/curl User-Agent gets served an anti-bot JS-challenge page
// (redirect + cookie-setting script) instead of JSON; a browser-shaped one
// goes straight through with no cookies/challenge needed at all.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const client = axios.create({
  baseURL: sberazsApiBaseUrl,
  timeout: proxyRequestTimeoutMs,
  headers: {
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  },
});

/**
 * Fetches gas stations for a bounding box from sberazs.ru. Bbox filtering is
 * genuinely server-side (verified live: a far-away bbox returns zero
 * stations, a tight one returns a proper subset) - a single comma-joined
 * `bbox=minLon,minLat,maxLon,maxLat` query param, unlike gdebenz's four
 * separate lat1/lon1/lat2/lon2 params. Deliberately no proxy pool, same
 * reasoning as gdebenzClient.js - a public endpoint with no sign (yet) that
 * it needs one.
 */
async function fetchStations({ minLat, maxLat, minLon, maxLon }) {
  const response = await client.get('', {
    params: { bbox: `${minLon},${minLat},${maxLon},${maxLat}` },
  });
  return response.data;
}

module.exports = { fetchStations };
