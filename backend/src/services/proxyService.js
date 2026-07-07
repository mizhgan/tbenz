const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const Proxy = require('../models/Proxy');
const { proxyFailureThreshold, proxyRequestTimeoutMs, proxyCheckUrl } = require('../config/env');
const logger = require('../utils/logger');

function buildProxyUrl(proxy) {
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
    : '';
  const scheme = proxy.type === 'socks5' ? 'socks5' : proxy.type;
  return `${scheme}://${auth}${proxy.host}:${proxy.port}`;
}

function buildAgent(proxy) {
  const url = buildProxyUrl(proxy);
  if (proxy.type === 'socks5') return new SocksProxyAgent(url);
  if (proxy.type === 'https') return new HttpsProxyAgent(url);
  return new HttpProxyAgent(url);
}

async function pickRandomActiveProxy(excludeIds = []) {
  const excluded = excludeIds.map(String);
  const candidates = await Proxy.find({ active: true, _id: { $nin: excluded } });
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

async function recordSuccess(proxyId) {
  await Proxy.findByIdAndUpdate(proxyId, {
    $set: {
      consecutiveFailures: 0,
      lastUsedAt: new Date(),
      lastSuccessAt: new Date(),
      lastError: null,
    },
  });
}

async function recordFailure(proxyId, err) {
  const proxy = await Proxy.findById(proxyId);
  if (!proxy) return;

  proxy.consecutiveFailures += 1;
  proxy.lastUsedAt = new Date();
  proxy.lastErrorAt = new Date();
  proxy.lastError = err?.message || String(err);

  if (proxy.consecutiveFailures >= proxyFailureThreshold && proxy.active) {
    proxy.active = false;
    proxy.disabledReason = `Автоматически отключен после ${proxy.consecutiveFailures} ошибок подряд`;
    logger.warn(
      `Proxy ${proxy.host}:${proxy.port} auto-disabled after ${proxy.consecutiveFailures} consecutive failures`
    );
  }

  await proxy.save();
}

/**
 * Fires a single request through the given proxy to verify connectivity.
 * Does not touch the failure-count/auto-disable bookkeeping used for live
 * traffic - this is a standalone manual check, its result is reported
 * separately (lastCheck* fields) so it doesn't interact with the
 * consecutiveFailures counter that drives auto-disabling.
 */
async function testProxy(proxy) {
  const agent = buildAgent(proxy);
  const startedAt = Date.now();
  try {
    await axios.get(proxyCheckUrl, {
      httpAgent: agent,
      httpsAgent: agent,
      proxy: false,
      timeout: proxyRequestTimeoutMs,
      validateStatus: () => true,
    });
    return { ok: true, latencyMs: Date.now() - startedAt, error: null };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: err.message };
  }
}

module.exports = {
  buildAgent,
  pickRandomActiveProxy,
  recordSuccess,
  recordFailure,
  testProxy,
};
