const { Schema, model } = require('mongoose');

const regionSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    minLat: { type: Number, required: true },
    maxLat: { type: Number, required: true },
    minLon: { type: Number, required: true },
    maxLon: { type: Number, required: true },
    pollIntervalMinutes: { type: Number, required: true, default: 10, min: 1 },
    active: { type: Boolean, default: true },
    lastPolledAt: { type: Date, default: null },
    lastPollStatus: { type: String, enum: ['ok', 'error', 'never'], default: 'never' },
    lastPollError: { type: String, default: null },
    lastPollStationCount: { type: Number, default: 0 },
    // Same shape as the tbank poll-status fields above, but for the second
    // (gdebenz) source - polled on the same schedule/bbox, see
    // gdebenzIngestService.js. Kept separate so a gdebenz outage is visible
    // in the admin panel without being confused with (or masking) a tbank
    // poll failure.
    lastGdebenzPolledAt: { type: Date, default: null },
    lastGdebenzPollStatus: { type: String, enum: ['ok', 'error', 'never'], default: 'never' },
    lastGdebenzPollError: { type: String, default: null },
    lastGdebenzPollStationCount: { type: Number, default: 0 },
    // Generalized replacement for the four lastGdebenz* fields above, one
    // entry per registered secondary source (see services/sourceRegistry.js)
    // instead of a new set of named fields per source. Written alongside the
    // gdebenz-specific fields for now (dual-write, see gdebenzIngestService.js)
    // until every reader has migrated over.
    sourcePollStatus: [
      {
        _id: false,
        sourceKey: { type: String, required: true },
        lastPolledAt: { type: Date, default: null },
        status: { type: String, enum: ['ok', 'error', 'never'], default: 'never' },
        error: { type: String, default: null },
        stationCount: { type: Number, default: 0 },
      },
    ],
  },
  { timestamps: true }
);

regionSchema.index({ minLat: 1, maxLat: 1, minLon: 1, maxLon: 1 });

module.exports = model('Region', regionSchema);
