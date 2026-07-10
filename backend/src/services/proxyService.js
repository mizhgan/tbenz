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

// Finds (or creates) this proxy's per-source stat entry and returns the
// live subdocument to mutate in place - shared by the non-tbank branches of
// recordSuccess/recordFailure below. See Proxy.js's doc comment on
// sourceStats for why every source but tbank goes through here instead of
// the top-level counters.
function getOrCreateSourceStat(proxy, sourceKey) {
  let entry = proxy.sourceStats.find((s) => s.sourceKey === sourceKey);
  if (!entry) {
    proxy.sourceStats.push({ sourceKey });
    entry = proxy.sourceStats[proxy.sourceStats.length - 1];
  }
  return entry;
}

/**
 * Records a successful request through this proxy. `sourceKey` defaults to
 * 'tbank' (this pool's original consumer, and every existing call site) -
 * only tbank's outcomes touch the top-level counters that drive
 * auto-disabling; any other source updates its own entry in sourceStats
 * instead, purely for visibility (see Proxy.js's doc comment).
 */
async function recordSuccess(proxyId, sourceKey = 'tbank') {
  if (sourceKey === 'tbank') {
    await Proxy.findByIdAndUpdate(proxyId, {
      $set: {
        consecutiveFailures: 0,
        lastUsedAt: new Date(),
        lastSuccessAt: new Date(),
        lastError: null,
      },
      $inc: { totalRequests: 1, successCount: 1 },
    });
    return;
  }

  const proxy = await Proxy.findById(proxyId);
  if (!proxy) return;
  const stat = getOrCreateSourceStat(proxy, sourceKey);
  stat.totalRequests += 1;
  stat.successCount += 1;
  stat.consecutiveFailures = 0;
  stat.lastUsedAt = new Date();
  stat.lastSuccessAt = new Date();
  stat.lastError = null;
  await proxy.save();
}

/**
 * Records a failed request through this proxy - see recordSuccess's doc
 * comment for the sourceKey split. Only a tbank failure can push
 * consecutiveFailures past proxyFailureThreshold and auto-disable the
 * proxy; a non-tbank source accumulates its own consecutiveFailures in
 * sourceStats but can never disable the proxy for everyone else.
 */
async function recordFailure(proxyId, err, sourceKey = 'tbank') {
  const proxy = await Proxy.findById(proxyId);
  if (!proxy) return;

  if (sourceKey === 'tbank') {
    proxy.consecutiveFailures += 1;
    proxy.totalRequests += 1;
    proxy.failureCount += 1;
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
  } else {
    const stat = getOrCreateSourceStat(proxy, sourceKey);
    stat.totalRequests += 1;
    stat.failureCount += 1;
    stat.consecutiveFailures += 1;
    stat.lastUsedAt = new Date();
    stat.lastErrorAt = new Date();
    stat.lastError = err?.message || String(err);
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
