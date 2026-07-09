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
    // Superseded by sourcePollStatus below (generalized to N secondary
    // sources - see services/sourceRegistry.js/secondarySourceIngestService.js).
    // No longer written (confirmed nothing in the frontend reads these
    // either); kept only until Stage 4 of the source-generalization refactor
    // drops the fields outright.
    lastGdebenzPolledAt: { type: Date, default: null },
    lastGdebenzPollStatus: { type: String, enum: ['ok', 'error', 'never'], default: 'never' },
    lastGdebenzPollError: { type: String, default: null },
    lastGdebenzPollStationCount: { type: Number, default: 0 },
    // One entry per registered secondary source (see services/
    // sourceRegistry.js), written by secondarySourceIngestService.js -
    // replaces the four lastGdebenz* fields above.
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
