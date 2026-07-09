const axios = require('axios');
const { gdebenzApiBaseUrl, proxyRequestTimeoutMs } = require('../config/env');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const client = axios.create({
  baseURL: gdebenzApiBaseUrl,
  timeout: proxyRequestTimeoutMs,
  headers: {
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  },
});

/**
 * Fetches gas stations for a bounding box from gdebenz.ru. Unlike
 * tbankClient.js, this deliberately does not go through the proxy pool -
 * gdebenz.ru is a separate, unauthenticated public endpoint with no
 * indication (yet) that it needs one; the proxy pool can be wired in later
 * the same way if this host turns out to need it too.
 */
async function fetchStations({ minLat, maxLat, minLon, maxLon }) {
  const response = await client.get('', {
    params: { lat1: minLat, lon1: minLon, lat2: maxLat, lon2: maxLon },
  });
  return response.data;
}

module.exports = { fetchStations };
