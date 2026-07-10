const { Schema, model } = require('mongoose');

// One row per poll attempt per source (tbank or a registered secondary
// source, see services/sourceRegistry.js) - lets the admin Regions page show
// actual error trends/counts over time instead of only ever seeing the
// single latest attempt (Region.lastPollStatus/sourcePollStatus, which a
// subsequent successful poll silently overwrites), and catch a source that
// "succeeds" but returns 0 stations - the shape a silent block/rate-limit
// takes, indistinguishable from a real error without a history to compare
// against.
const sourcePollLogSchema = new Schema({
  region: { type: Schema.Types.ObjectId, ref: 'Region', required: true, index: true },
  sourceKey: { type: String, required: true },
  polledAt: { type: Date, required: true, default: Date.now },
  status: { type: String, enum: ['ok', 'error'], required: true },
  error: { type: String, default: null },
  stationCount: { type: Number, default: 0 },
});

sourcePollLogSchema.index({ region: 1, sourceKey: 1, polledAt: -1 });
// Rolling operational log, not historical data (StationSnapshot already
// covers long-term history) - auto-expires so it doesn't grow unbounded at
// one row per source per poll tick.
sourcePollLogSchema.index({ polledAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

module.exports = model('SourcePollLog', sourcePollLogSchema);
