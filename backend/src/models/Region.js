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
    // One entry per source this region is polled from, tbank included (see
    // services/regionPollStatus.js's setSourcePollStatus, the one write
    // path for this field - used by both ingestService.js for tbank and
    // secondarySourceIngestService.js for every other registered source,
    // see services/sourceRegistry.js). tbank isn't a distinguished first
    // entry here - it's upserted into this same array like any other
    // source key, in whatever position it first gets written to (the
    // frontend sorts it first for display, see RegionsView.vue's own
    // sourceRows). Used to be two different shapes - tbank on its own
    // dedicated top-level Region fields (lastPolledAt/lastPollStatus/
    // lastPollError/lastPollStationCount/lastRequestUrl/lastRawResponse),
    // every other source here - unified onto this one shape since the two
    // were the exact same concept with no real difference beyond history.
    //
    // requestUrl/rawResponse (the exact URL a poll attempt hit, built even
    // on failure - see tbankClient.buildRequestUrl/sourceConfig.buildRequestUrl
    // - and the raw response body from the last *successful* poll, capped,
    // see utils/rawResponseCap.js) are deliberately excluded from the
    // default list/get projections (regions.controller.js) since the admin
    // page polls those every 15s and a raw payload can be sizeable; fetched
    // on demand via GET /regions/:id/raw-response instead.
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
