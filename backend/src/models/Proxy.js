const { Schema, model } = require('mongoose');

const TYPES = ['http', 'https', 'socks5'];

const proxySchema = new Schema(
  {
    label: { type: String, trim: true, default: '' },
    type: { type: String, enum: TYPES, required: true },
    host: { type: String, required: true, trim: true },
    port: { type: Number, required: true, min: 1, max: 65535 },
    username: { type: String, trim: true, default: '' },
    password: { type: String, default: '' },
    active: { type: Boolean, default: true },
    // Incremented on each request failure while in use; reset on success.
    // Once it reaches the configured threshold the proxy is auto-disabled
    // (active set to false) so the scheduler stops picking it.
    consecutiveFailures: { type: Number, default: 0 },
    disabledReason: { type: String, default: null },
    // Lifetime counters across all actual data-fetch requests routed through
    // this proxy (not reset on success, unlike consecutiveFailures above;
    // manual "Проверить" checks don't count towards these).
    totalRequests: { type: Number, default: 0 },
    successCount: { type: Number, default: 0 },
    failureCount: { type: Number, default: 0 },
    lastUsedAt: { type: Date, default: null },
    lastSuccessAt: { type: Date, default: null },
    lastErrorAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    lastCheckedAt: { type: Date, default: null },
    lastCheckStatus: { type: String, enum: ['ok', 'error', 'never'], default: 'never' },
    lastCheckLatencyMs: { type: Number, default: null },
    lastCheckError: { type: String, default: null },
    // Every field above this point is deliberately tbank-only: tbank was
    // this pool's original (and until now, only) consumer, and
    // consecutiveFailures/active specifically drive auto-disabling, which
    // must keep reflecting *tbank's* experience with a proxy specifically.
    // A source that gets blocked for reasons that have nothing to do with
    // the proxy's IP (see sberazsClient.js's doc comment on its anti-bot
    // detection) would otherwise burn through this same counter and risk
    // auto-disabling a proxy that's perfectly fine for tbank. Every other
    // source routed through this pool gets its own entry here instead (see
    // proxyService.recordSuccess/recordFailure's sourceKey parameter) -
    // tracked for visibility, never touching the fields above.
    sourceStats: [
      {
        _id: false,
        sourceKey: { type: String, required: true },
        totalRequests: { type: Number, default: 0 },
        successCount: { type: Number, default: 0 },
        failureCount: { type: Number, default: 0 },
        consecutiveFailures: { type: Number, default: 0 },
        lastUsedAt: { type: Date, default: null },
        lastSuccessAt: { type: Date, default: null },
        lastErrorAt: { type: Date, default: null },
        lastError: { type: String, default: null },
      },
    ],
  },
  { timestamps: true }
);

proxySchema.index({ active: 1 });

const Proxy = model('Proxy', proxySchema);
Proxy.TYPES = TYPES;

module.exports = Proxy;
