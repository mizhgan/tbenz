const { Schema, model } = require('mongoose');

// One row per station per poll - the historical time series used for the
// map's time-slider and per-station price charts.
const stationSnapshotSchema = new Schema(
  {
    station: { type: Schema.Types.ObjectId, ref: 'Station', required: true, index: true },
    region: { type: Schema.Types.ObjectId, ref: 'Region', required: true, index: true },
    polledAt: { type: Date, required: true, default: Date.now, index: true },
    lat: { type: Number, required: true },
    lon: { type: Number, required: true },
    fuels: [
      {
        _id: false,
        type: { type: String },
        price: { type: Number },
      },
    ],
    raw: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: false }
);

stationSnapshotSchema.index({ station: 1, polledAt: -1 });
stationSnapshotSchema.index({ region: 1, polledAt: -1 });
stationSnapshotSchema.index({ region: 1, station: 1, polledAt: -1 });

module.exports = model('StationSnapshot', stationSnapshotSchema);
