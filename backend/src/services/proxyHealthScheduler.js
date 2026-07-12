const proxyService = require('./proxyService');
const { proxyRecheckIntervalMinutes } = require('../config/env');
const logger = require('../utils/logger');

const CHECK_INTERVAL_MS = proxyRecheckIntervalMinutes * 60 * 1000;

let handle = null;

async function tick() {
  try {
    const { checked, recovered } = await proxyService.recheckDisabledProxies();
    if (recovered > 0) {
      logger.info(`Proxy health check: ${recovered}/${checked} auto-disabled proxy(ies) recovered and re-enabled`);
    }
  } catch (err) {
    logger.error('Proxy health check tick failed:', err.message);
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
