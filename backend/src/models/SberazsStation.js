const { Schema, model } = require('mongoose');

// A station as reported by sberazs.ru (payment/transaction-based, same
// underlying signal shape as tbank - see sberazsParser.js) - its own
// collection for the same reason as GdebenzStation: sberazs's own
// identifiers (twoGisBranchId) don't correspond to tbank's externalId, so
// there's no natural join key, and keeping the two sources' raw records
// separate means a bad sberazs fetch or a wrong admin match can never
// corrupt the tbank-sourced data other consumers (metrics/reports/
// forecast/Telegram) already depend on.
const sberazsStationSchema = new Schema(
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
    // Station-level (not per-fuel-type) status, already mapped to the app's
    // common vocabulary - see sberazsParser.js's STATUS_MAP. Unlike gdebenz,
    // sberazs has no "confirmed not available" reading at all (only
    // available/stale/unknown) - see the parser's own doc comment.
    status: { type: String, default: 'no_data' },
    fuelTypes: [{ type: String }],
    // Genuine per-fuel-type readings, when this station's `fuels[]` entries
    // carry their own `availabilityStatus` (not every station does yet -
    // see sberazsParser.js's parseFuelStatuses). Kept separate from the
    // station-level status/fuelTypes above rather than replacing them: a
    // station without per-fuel data still falls back to the old
    // status-projected-onto-fuelTypes behavior (see
    // mergeStatusService.mergeStationFuelStatuses).
    fuelStatuses: [
      {
        _id: false,
        fuelType: { type: String },
        status: { type: String },
      },
    ],
    // sberazs's own crowd-vote layer (positiveVotes/negativeVotes/confidence,
    // see crowdState in the raw payload) - currently unpopulated across the
    // whole dataset, so not folded into `status` yet; kept in lastRaw only,
    // same reasoning as GdebenzStation.conflict being surfaced but not acted
    // on automatically.
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

sberazsStationSchema.index({ lat: 1, lon: 1 });
sberazsStationSchema.index({ matchedStationId: 1 });

module.exports = model('SberazsStation', sberazsStationSchema);
