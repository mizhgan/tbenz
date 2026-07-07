const axios = require('axios');
const { tbankApiBaseUrl } = require('../config/env');

const client = axios.create({
  baseURL: tbankApiBaseUrl,
  timeout: 20000,
  headers: {
    Accept: 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  },
});

/**
 * Fetches gas stations / recent transactions for a bounding box from
 * toplivo.tbank.ru. The exact response shape hasn't been verified against a
 * live call (network access to the host is unavailable in this dev
 * environment), so callers must treat the payload defensively - see
 * ingestService.extractStationsArray / parseStation.
 */
async function fetchStations({ minLat, maxLat, minLon, maxLon }) {
  const response = await client.get('', {
    params: { minLat, maxLat, minLon, maxLon },
  });
  return response.data;
}

module.exports = { fetchStations };
