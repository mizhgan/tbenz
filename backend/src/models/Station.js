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
    // Last known overall availability status and per-fuel-type breakdown -
    // the *effective* value everything else in the app reads (metrics,
    // reports, forecasts, Telegram, map markers): tbank's own reading until
    // a gdebenz match is confirmed, the merged result afterward (see
    // mergeStatusService.js / gdebenzIngestService.js).
    // "available" | "maybe_available" | "not_available" | "no_data".
    lastStatus: { type: String, default: 'no_data' },
    lastFuelStatuses: [
      {
        _id: false,
        fuelType: { type: String },
        status: { type: String },
      },
    ],
    // tbank's own reading, kept separately from the (possibly merged)
    // lastStatus/lastFuelStatuses above - written only by
    // ingestService.storeStation, never touched by the gdebenz merge. Exists
    // purely so the admin station-detail view can show "what did tbank
    // itself say" side by side with gdebenz's own reading and the merged
    // result, instead of only ever seeing the already-blended value.
    tbankLastStatus: { type: String, default: 'no_data' },
    tbankLastFuelStatuses: [
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
    // Set once an admin confirms this Station is the same physical station
    // as a GdebenzStation (see stationMatchingController.js). Once set,
    // gdebenzIngestService.js folds that second source's readings into
    // lastStatus/lastFuelStatuses below via mergeStatusService.js - so from
    // every other consumer's point of view (metrics, reports, forecasts,
    // Telegram) a matched station's status is simply "what's currently in
    // Station", same as always; they don't need to know it's now blended
    // from two sources.
    gdebenzStationId: { type: Schema.Types.ObjectId, ref: 'GdebenzStation', default: null },
  },
  { timestamps: true }
);

stationSchema.index({ lat: 1, lon: 1 });

module.exports = model('Station', stationSchema);
