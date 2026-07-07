const { Schema, model } = require('mongoose');

// A station is a physical gas station, deduplicated by externalId across regions
// (bounding boxes of different tracked regions may overlap).
const stationSchema = new Schema(
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
    // Best-effort parsed latest fuel prices, kept for quick display without
    // joining the snapshot collection.
    lastFuels: [
      {
        _id: false,
        type: { type: String },
        price: { type: Number },
      },
    ],
    // Full raw payload for this station as last received from the source API,
    // kept so nothing is lost if our field-mapping guesses above are wrong.
    lastRaw: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

stationSchema.index({ lat: 1, lon: 1 });

module.exports = model('Station', stationSchema);
