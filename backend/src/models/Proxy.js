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
    lastUsedAt: { type: Date, default: null },
    lastSuccessAt: { type: Date, default: null },
    lastErrorAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    lastCheckedAt: { type: Date, default: null },
    lastCheckStatus: { type: String, enum: ['ok', 'error', 'never'], default: 'never' },
    lastCheckLatencyMs: { type: Number, default: null },
    lastCheckError: { type: String, default: null },
  },
  { timestamps: true }
);

proxySchema.index({ active: 1 });

const Proxy = model('Proxy', proxySchema);
Proxy.TYPES = TYPES;

module.exports = Proxy;
