const { Schema, model } = require('mongoose');

// One row per *closed* not_available -> available/maybe_available streak,
// scoped per (station, region) since a station in two overlapping regions
// (Station.regions is an array) gets independently-timed StationSnapshot
// rows per region and can be mid-outage in one while fine in the other. Kept
// in sync incrementally by ingestService.js's ingestRegion (see
// Station.openOutages for the in-progress half of the same state machine)
// instead of metricsService.js re-deriving it from raw StationSnapshot
// history on every report request - see computeOutages's own doc comment for
// the streak rules this mirrors exactly.
const stationOutageSchema = new Schema(
  {
    station: { type: Schema.Types.ObjectId, ref: 'Station', required: true },
    region: { type: Schema.Types.ObjectId, ref: 'Region', required: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    durationMinutes: { type: Number, required: true },
  },
  { timestamps: false }
);

stationOutageSchema.index({ station: 1, end: -1 });
stationOutageSchema.index({ region: 1, end: -1 });

module.exports = model('StationOutage', stationOutageSchema);
