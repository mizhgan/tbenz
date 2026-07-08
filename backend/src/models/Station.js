const { Schema, model } = require('mongoose');

// A station is a physical gas station, deduplicated by externalId across regions
// (bounding boxes of different tracked regions may overlap).
const stationSchema = new Schema(
  {
    externalId: { type: String, required: true, unique: true, index: true },
    name: { type: String, default: null },
    address: { type: String, default: null },
    lat: { type: Number, required: true },
    lon: { type: Number, required: true },
    yandexOrgId: { type: String, default: null },
    regions: [{ type: Schema.Types.ObjectId, ref: 'Region' }],
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    // Last known overall availability status and per-fuel-type breakdown, as
    // reported by the source (inferred from recent transaction activity, not
    // an actual price/stock feed): "available" | "maybe_available" |
    // "not_available" | "no_data".
    lastStatus: { type: String, default: 'no_data' },
    lastFuelStatuses: [
      {
        _id: false,
        fuelType: { type: String },
        status: { type: String },
      },
    ],
    lastTransactionAt: { type: Date, default: null },
    // Full raw payload for this station as last received from the source API,
    // kept so nothing is lost if our field-mapping assumptions above change.
    lastRaw: { type: Schema.Types.Mixed, default: null },
    // Cooldown markers for Telegram predictive alerts - prevents re-alerting
    // on every scan while a station's predicted risk/recovery is still
    // ongoing (see telegramPredictiveAlerts.js).
    lastPredictiveDropAlertAt: { type: Date, default: null },
    lastPredictiveRecoveryAlertAt: { type: Date, default: null },
  },
  { timestamps: true }
);

stationSchema.index({ lat: 1, lon: 1 });

module.exports = model('Station', stationSchema);
