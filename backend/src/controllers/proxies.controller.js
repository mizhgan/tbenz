const asyncHandler = require('../utils/asyncHandler');
const { HttpError } = require('../middleware/errorHandler');
const Proxy = require('../models/Proxy');
const proxyService = require('../services/proxyService');

function serializeProxy(p) {
  return {
    id: p._id,
    label: p.label,
    type: p.type,
    host: p.host,
    port: p.port,
    username: p.username,
    hasPassword: Boolean(p.password),
    active: p.active,
    consecutiveFailures: p.consecutiveFailures,
    disabledReason: p.disabledReason,
    totalRequests: p.totalRequests,
    successCount: p.successCount,
    failureCount: p.failureCount,
    lastUsedAt: p.lastUsedAt,
    lastSuccessAt: p.lastSuccessAt,
    lastErrorAt: p.lastErrorAt,
    lastError: p.lastError,
    lastCheckedAt: p.lastCheckedAt,
    lastCheckStatus: p.lastCheckStatus,
    lastCheckLatencyMs: p.lastCheckLatencyMs,
    lastCheckError: p.lastCheckError,
    createdAt: p.createdAt,
  };
}

function validateProxyInput(body, { partial = false } = {}) {
  const out = {};
  const fields = ['label', 'type', 'host', 'port', 'username', 'password', 'active'];
  for (const field of fields) {
    if (body[field] !== undefined) out[field] = body[field];
  }

  if (!partial || out.type !== undefined) {
    if (!Proxy.TYPES.includes(out.type)) {
      throw new HttpError(400, `type must be one of: ${Proxy.TYPES.join(', ')}`);
    }
  }

  if (!partial || out.host !== undefined) {
    if (typeof out.host !== 'string' || !out.host.trim()) {
      throw new HttpError(400, 'host is required');
    }
    out.host = out.host.trim();
  }

  if (!partial || out.port !== undefined) {
    const port = Number(out.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new HttpError(400, 'port must be an integer between 1 and 65535');
    }
    out.port = port;
  }

  if (out.label !== undefined) out.label = String(out.label).trim();
  if (out.username !== undefined) out.username = String(out.username).trim();
  if (out.active !== undefined) out.active = Boolean(out.active);

  return out;
}

const listProxies = asyncHandler(async (req, res) => {
  const proxies = await Proxy.find().sort({ createdAt: 1 });
  res.json(proxies.map(serializeProxy));
});

const createProxy = asyncHandler(async (req, res) => {
  const data = validateProxyInput(req.body);
  const proxy = await Proxy.create({
    label: data.label || '',
    type: data.type,
    host: data.host,
    port: data.port,
    username: data.username || '',
    password: data.password || '',
    active: data.active ?? true,
  });
  res.status(201).json(serializeProxy(proxy));
});

const updateProxy = asyncHandler(async (req, res) => {
  const proxy = await Proxy.findById(req.params.id);
  if (!proxy) throw new HttpError(404, 'Proxy not found');

  const data = validateProxyInput(req.body, { partial: true });
  // An admin explicitly re-activating a proxy (e.g. after fixing it) should
  // also clear the auto-disable bookkeeping, otherwise one more failure
  // would immediately re-trip the threshold.
  if (data.active === true && !proxy.active) {
    proxy.consecutiveFailures = 0;
    proxy.disabledReason = null;
  }
  Object.assign(proxy, data);
  await proxy.save();
  res.json(serializeProxy(proxy));
});

const deleteProxy = asyncHandler(async (req, res) => {
  const proxy = await Proxy.findById(req.params.id);
  if (!proxy) throw new HttpError(404, 'Proxy not found');
  await proxy.deleteOne();
  res.status(204).end();
});

const checkProxy = asyncHandler(async (req, res) => {
  const proxy = await Proxy.findById(req.params.id);
  if (!proxy) throw new HttpError(404, 'Proxy not found');

  const result = await proxyService.testProxy(proxy);
  proxy.lastCheckedAt = new Date();
  proxy.lastCheckStatus = result.ok ? 'ok' : 'error';
  proxy.lastCheckLatencyMs = result.latencyMs;
  proxy.lastCheckError = result.error;
  await proxy.save();

  res.json(serializeProxy(proxy));
});

module.exports = { listProxies, createProxy, updateProxy, deleteProxy, checkProxy };
