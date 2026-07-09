const { Schema, model } = require('mongoose');

// A station as reported by gdebenz.ru - deliberately its own collection
// rather than folded into Station directly (see stationMatchingService.js /
// mergeStatusService.js): gdebenz's own identifiers (osm_id) don't correspond
// to tbank's externalId at all, so there's no natural join key, and keeping
// the two sources' raw records separate means a bad gdebenz fetch or a wrong
// admin match can never corrupt the tbank-sourced data other consumers
// (metrics/reports/forecast/Telegram) already depend on.
const gdebenzStationSchema = new Schema(
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
    // common vocabulary - see gdebenzParser.js's STATUS_MAP.
    status: { type: String, default: 'no_data' },
    fuelTypes: [{ type: String }],
    // gdebenz's own crowdsourced-report disagreement signal - unrelated to
    // whether this reading agrees with tbank; surfaced to admins reviewing a
    // match, not folded into `status`.
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

gdebenzStationSchema.index({ lat: 1, lon: 1 });
gdebenzStationSchema.index({ matchedStationId: 1 });

module.exports = model('GdebenzStation', gdebenzStationSchema);
