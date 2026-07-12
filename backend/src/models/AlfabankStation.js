const { Schema, model } = require('mongoose');

// A station as reported by alfabank.ru's public azs-stations API
// (transaction/payment-based per-fuel-type status, same underlying signal
// shape as tbank - see alfabankParser.js) - its own collection for the same
// reason as GdebenzStation/SberazsStation: alfabank's own identifier
// (station_id, a UUID) doesn't correspond to tbank's externalId, so there's
// no natural join key, and keeping this source's raw records separate means
// a bad alfabank fetch or a wrong admin match can never corrupt the
// tbank-sourced data other consumers (metrics/reports/forecast/Telegram)
// already depend on.
const alfabankStationSchema = new Schema(
  {
    externalId: { type: String, required: true, unique: true, index: true },
    name: { type: String, default: null },
    brand: { type: String, default: null },
    address: { type: String, default: null },
    lat: { type: Number, required: true },
    lon: { type: Number, required: true },
    regions: [{ type: Schema.Types.ObjectId, ref: 'Region' }],
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    // Derived from fuelStatuses below - unlike gdebenz/sberazs, this source's
    // payload has no station-level status field of its own at all, only four
    // per-fuel-type readings (see alfabankParser.js's deriveOverallStatus).
    status: { type: String, default: 'no_data' },
    fuelTypes: [{ type: String }],
    // Genuine per-fuel-type readings - alfabank reports all four categories
    // (92/95/100/ДТ) for essentially every station on every poll, unlike
    // gdebenz (no per-fuel data at all) or sberazs (only some stations
    // upgraded so far) - see sourceRegistry.js's weight for why this source
    // is trusted at the same level as tbank rather than discounted.
    fuelStatuses: [
      {
        _id: false,
        fuelType: { type: String },
        status: { type: String },
        // Kept even when it pushed `status` down to no_data for being stale
        // (see alfabankParser.js) - "we don't trust this as current" and
        // "we have no idea when this was last seen" are different things
        // worth showing separately in the UI (StationDetailModal's per-source
        // fuel table).
        lastTransactionAt: { type: Date, default: null },
      },
    ],
    conflict: { type: String, default: null },
    lastRaw: { type: Schema.Types.Mixed, default: null },

    // Set once an admin confirms this is the same physical station as a
    // Station document (see stationMatchingController.js) - matching is
    // always a deliberate admin action, never automatic, so a wrong
    // geo/name-similarity guess can't silently merge two different stations.
    matchedStationId: { type: Schema.Types.ObjectId, ref: 'Station', default: null },
    // Admin has reviewed and decided this isn't a real match for anything
    // (e.g. a duplicate/test entry, or a station tbank doesn't cover) -
    // keeps it out of the "unmatched, needs review" queue without pretending
    // it's matched to something.
    ignored: { type: Boolean, default: false },
  },
  { timestamps: true }
);

alfabankStationSchema.index({ lat: 1, lon: 1 });
alfabankStationSchema.index({ matchedStationId: 1 });

module.exports = model('AlfabankStation', alfabankStationSchema);
