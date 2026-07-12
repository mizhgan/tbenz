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

// Playwright's context `proxy` option wants a plain {server, username,
// password} shape, not a Node http.Agent (buildAgent above is specific to
// axios/Node's own http(s) stack and can't be reused here) - same
// credentials, different transport (see browserFetchService.js, used by
// sberazsClient.js). Credentials go in their own fields rather than the
// server URL - Playwright reads them separately and Chromium's proxy auth
// prompt only responds to that form.
function buildPlaywrightProxyOption(proxy) {
  const scheme = proxy.type === 'socks5' ? 'socks5' : proxy.type;
  return {
    server: `${scheme}://${proxy.host}:${proxy.port}`,
    username: proxy.username || undefined,
    password: proxy.password || undefined,
  };
}

// Chromium (via Playwright) can't authenticate to a SOCKS5 proxy at all -
// a hard limitation of Chromium itself, confirmed live (see
// sberazsClient.js/browserFetchService.js), not a per-proxy problem worth
// retrying against. A source that fetches through a headless browser
// should only ever be offered a proxy type it can actually use - http/
// https (with or without credentials) or an unauthenticated SOCKS5.
function isBrowserCompatible(proxy) {
  return proxy.type !== 'socks5' || !proxy.username;
}

async function pickRandomActiveProxy(excludeIds = [], { browserCompatible = false } = {}) {
  const excluded = excludeIds.map(String);
  let candidates = await Proxy.find({ active: true, _id: { $nin: excluded } });
  if (browserCompatible) candidates = candidates.filter(isBrowserCompatible);
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

// Prefix set on Proxy.disabledReason by recordFailure's auto-disable path
// above - the one reliable way to tell "this proxy got auto-disabled and
// might just be temporarily down" apart from "an admin turned this off on
// purpose" (an admin-initiated deactivation via updateProxy never sets
// disabledReason at all - see proxies.controller.js).
const AUTO_DISABLE_PREFIX = 'Автоматически отключен';

/**
 * Retests every currently auto-disabled proxy (see AUTO_DISABLE_PREFIX
 * above) and re-activates whichever ones pass - a proxy that tripped the
 * failure threshold is often only temporarily down (rate-limited, the
 * vendor restarted it, etc.), and previously stayed disabled until an
 * admin happened to notice and flip it back on by hand. Reuses testProxy
 * exactly like the manual "Проверить" button, including writing the same
 * lastCheck* fields, so a recovered proxy's admin-panel row looks no
 * different from one an admin just checked themselves. Proxies an admin
 * disabled on purpose (no disabledReason) are never touched here.
 */
async function recheckDisabledProxies() {
  const candidates = await Proxy.find({ active: false, disabledReason: new RegExp(`^${AUTO_DISABLE_PREFIX}`) });
  let recovered = 0;
  for (const proxy of candidates) {
    const result = await testProxy(proxy);
    proxy.lastCheckedAt = new Date();
    proxy.lastCheckStatus = result.ok ? 'ok' : 'error';
    proxy.lastCheckLatencyMs = result.latencyMs;
    proxy.lastCheckError = result.error;
    if (result.ok) {
      proxy.active = true;
      proxy.consecutiveFailures = 0;
      proxy.disabledReason = null;
      recovered += 1;
    }
    await proxy.save();
  }
  return { checked: candidates.length, recovered };
}

module.exports = {
  buildAgent,
  buildPlaywrightProxyOption,
  isBrowserCompatible,
  pickRandomActiveProxy,
  recordSuccess,
  recordFailure,
  recheckDisabledProxies,
  testProxy,
};
