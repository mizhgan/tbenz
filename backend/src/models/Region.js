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
    // The exact URL tbank's last poll attempt hit (built even on failure -
    // see tbankClient.buildRequestUrl) and the raw response body from its
    // last *successful* poll (capped, see utils/rawResponseCap.js) - lets an
    // admin copy the request to test manually, or see exactly what came back
    // before parsing, from the Regions page. Deliberately excluded from the
    // default list/get projections (regions.controller.js) since the admin
    // page polls those every 15s and a raw payload can be sizeable; fetched
    // on demand via GET /regions/:id/raw-response instead.
    lastRequestUrl: { type: String, default: null },
    lastRawResponse: { type: Schema.Types.Mixed, default: null },
    // One entry per registered secondary source (see services/
    // sourceRegistry.js), written by secondarySourceIngestService.js.
    sourcePollStatus: [
      {
        _id: false,
        sourceKey: { type: String, required: true },
        lastPolledAt: { type: Date, default: null },
        status: { type: String, enum: ['ok', 'error', 'never'], default: 'never' },
        error: { type: String, default: null },
        stationCount: { type: Number, default: 0 },
        requestUrl: { type: String, default: null },
        rawResponse: { type: Schema.Types.Mixed, default: null },
      },
    ],
  },
  { timestamps: true }
);

regionSchema.index({ minLat: 1, maxLat: 1, minLon: 1, maxLon: 1 });

module.exports = model('Region', regionSchema);
