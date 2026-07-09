const asyncHandler = require('../utils/asyncHandler');
const { HttpError } = require('../middleware/errorHandler');
const GdebenzStation = require('../models/GdebenzStation');
const Station = require('../models/Station');
const Region = require('../models/Region');
const stationMatchingService = require('../services/stationMatchingService');
const gdebenzIngestService = require('../services/gdebenzIngestService');

function serializeGdebenz(g) {
  return {
    id: g._id,
    externalId: g.externalId,
    name: g.name,
    brand: g.brand,
    address: g.address,
    lat: g.lat,
    lon: g.lon,
    status: g.status,
    fuelTypes: g.fuelTypes,
    conflict: g.conflict,
    lastSeenAt: g.lastSeenAt,
    ignored: g.ignored,
  };
}

// Not paginated on purpose - "unmatched, needs review" is meant to trend
// toward zero as an admin works through it, unlike the station lists
// elsewhere in the app which cover every station indefinitely.
const UNMATCHED_LIMIT = 200;

const listUnmatched = asyncHandler(async (req, res) => {
  const candidates = await GdebenzStation.find({ matchedStationId: null, ignored: false })
    .sort({ lastSeenAt: -1 })
    .limit(UNMATCHED_LIMIT);

  const items = await Promise.all(
    candidates.map(async (g) => ({
      ...serializeGdebenz(g),
      suggestions: (await stationMatchingService.suggestMatches(g)).map((s) => ({
        stationId: s.stationId,
        name: s.name,
        address: s.address,
        distanceMeters: s.distanceMeters,
        nameSimilarity: s.nameSimilarity,
        alreadyMatched: s.alreadyMatched,
      })),
    }))
  );

  res.json(items);
});

const listMatched = asyncHandler(async (req, res) => {
  const matches = await GdebenzStation.find({ matchedStationId: { $ne: null } })
    .sort({ updatedAt: -1 })
    .populate('matchedStationId', 'name address lastStatus');

  res.json(
    matches.map((g) => ({
      ...serializeGdebenz(g),
      station: g.matchedStationId
        ? {
            id: g.matchedStationId._id,
            name: g.matchedStationId.name,
            address: g.matchedStationId.address,
            lastStatus: g.matchedStationId.lastStatus,
          }
        : null,
    }))
  );
});

const confirmMatch = asyncHandler(async (req, res) => {
  const gdebenzStation = await GdebenzStation.findById(req.params.id);
  if (!gdebenzStation) throw new HttpError(404, 'Gdebenz station not found');

  const { stationId } = req.body || {};
  if (!stationId) throw new HttpError(400, 'stationId is required');
  const station = await Station.findById(stationId);
  if (!station) throw new HttpError(404, 'Station not found');

  gdebenzStation.matchedStationId = station._id;
  gdebenzStation.ignored = false;
  await gdebenzStation.save();
  station.gdebenzStationId = gdebenzStation._id;
  await station.save();

  // Apply immediately rather than waiting for the next poll tick, so the
  // admin sees the merged effect right away - the same write path
  // gdebenzIngestService uses during ordinary ingestion, just triggered by
  // this confirmation instead of a fresh gdebenz reading. Needs a Region for
  // the StationSnapshot it writes; any region the gdebenz station was seen
  // in works equally well here, since a snapshot's `region` is just which
  // poll loop produced it; the merged status itself isn't region-specific.
  const region = await Region.findOne({ _id: { $in: gdebenzStation.regions } });
  if (region) {
    await gdebenzIngestService.applyMergeToStation(station, gdebenzStation, region, new Date());
  }

  res.json({ ok: true });
});

const ignoreGdebenzStation = asyncHandler(async (req, res) => {
  const gdebenzStation = await GdebenzStation.findById(req.params.id);
  if (!gdebenzStation) throw new HttpError(404, 'Gdebenz station not found');
  gdebenzStation.ignored = true;
  await gdebenzStation.save();
  res.json({ ok: true });
});

const unmatch = asyncHandler(async (req, res) => {
  const gdebenzStation = await GdebenzStation.findById(req.params.id);
  if (!gdebenzStation) throw new HttpError(404, 'Gdebenz station not found');

  if (gdebenzStation.matchedStationId) {
    await Station.updateOne({ _id: gdebenzStation.matchedStationId }, { $set: { gdebenzStationId: null } });
  }
  gdebenzStation.matchedStationId = null;
  await gdebenzStation.save();
  res.json({ ok: true });
});

module.exports = { listUnmatched, listMatched, confirmMatch, ignoreGdebenzStation, unmatch };
