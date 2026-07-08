const Region = require('../models/Region');
const { notifyPredictiveAlerts } = require('./telegramNotifier');
const logger = require('../utils/logger');

// Forecasts are read off historical (weekday, hour) profiles that don't
// meaningfully change between polls - checking every 30 minutes is plenty,
// and keeps the whole-region bulk scan (see telegramPredictiveAlerts.js)
// from running far more often than it needs to.
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

let handle = null;

async function tick() {
  const regions = await Region.find({ active: true });
  for (const region of regions) {
    try {
      await notifyPredictiveAlerts(region);
    } catch (err) {
      logger.error(`Telegram predictive-alert scan failed for region ${region.name}:`, err.message);
    }
  }
}

function start() {
  if (handle) return;
  handle = setInterval(() => {
    tick().catch((err) => logger.error('Telegram predictive-alert tick failed:', err.message));
  }, CHECK_INTERVAL_MS);
  tick().catch((err) => logger.error('Telegram predictive-alert tick failed:', err.message));
}

function stop() {
  if (handle) {
    clearInterval(handle);
    handle = null;
  }
}

module.exports = { start, stop };
