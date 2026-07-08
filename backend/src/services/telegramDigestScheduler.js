const { sendDigest } = require('./telegramNotifier');
const logger = require('../utils/logger');

// Checked every 5 minutes rather than cron-aligned to the hour/day - each
// chat tracks its own lastHourlyDigestAt/lastDailyDigestAt (see
// telegramNotifier.sendDigest), so a chat gets its digest within 5 minutes
// of actually being due regardless of when the process last restarted.
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

let handle = null;

async function tick() {
  try {
    await sendDigest('hourly');
  } catch (err) {
    logger.error('Telegram hourly digest tick failed:', err.message);
  }
  try {
    await sendDigest('daily');
  } catch (err) {
    logger.error('Telegram daily digest tick failed:', err.message);
  }
}

function start() {
  if (handle) return;
  handle = setInterval(tick, CHECK_INTERVAL_MS);
  tick();
}

function stop() {
  if (handle) {
    clearInterval(handle);
    handle = null;
  }
}

module.exports = { start, stop };
