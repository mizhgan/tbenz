const { Schema, model } = require('mongoose');

// A station is a physical gas station. Originally deduplicated purely by
// externalId (tbank's own `id` field) across regions (bounding boxes of
// different tracked regions may overlap) - turned out NOT to be a stable
// per-physical-station key in practice: real production data showed the
// same address/coordinates/yandexOrgId getting a second Station document
// with a brand new externalId days after the first one already existed,
// both continuing to update in the same poll cycle afterward (see
// ingestService.storeStation's dedupe filter, which now prefers
// yandexOrgId - a third-party identifier for the physical business
// location - over externalId whenever tbank reports one). No longer
// `unique` for that reason: with externalId demoted to "best available
// fallback key, not a stable identity", nothing guarantees a value tbank
// hands out won't reappear against a different physical station later.
const stationSchema = new Schema(
  {
    externalId: { type: String, required: true, index: true },
    name: { type: String, default: null },
    address: { type: String, default: null },
    lat: { type: Number, required: true },
    lon: { type: Number, required: true },
    // Preferred dedupe key when present (see ingestService.storeStation) -
    // not enforced unique here on purpose: prefer risking an occasional
    // missed merge over a hard upsert failure if this assumption ever
    // turns out imperfect for some edge case.
    yandexOrgId: { type: String, default: null, index: true },
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
    // When tbank itself last polled this station - unlike lastSeenAt below,
    // never touched by the gdebenz merge, so the admin station-detail view
    // can show "when did tbank actually last see this station" instead of
    // whichever source happened to poll most recently in a merged cycle.
    tbankLastSeenAt: { type: Date, default: null },
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
