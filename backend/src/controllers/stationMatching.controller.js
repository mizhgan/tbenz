const asyncHandler = require('../utils/asyncHandler');
const { HttpError } = require('../middleware/errorHandler');
const Station = require('../models/Station');
const Region = require('../models/Region');
const stationMatchingService = require('../services/stationMatchingService');
const secondarySourceIngestService = require('../services/secondarySourceIngestService');
const { getSource, listSources } = require('../services/sourceRegistry');

// Helpers for Station.sourceLinks (see the field's doc comment on the
// model). Uses the same $pull-then-$addToSet two-call pattern as
// scripts/mergeDuplicateStations.js, since Mongo rejects $pull and
// $addToSet on the same array path in one update.
function setSourceLink(station, sourceKey, refId) {
  station.sourceLinks = (station.sourceLinks || []).filter((l) => l.sourceKey !== sourceKey);
  station.sourceLinks.push({ sourceKey, refId });
}

async function clearSourceLink(stationId, sourceKey) {
  await Station.updateOne({ _id: stationId }, { $pull: { sourceLinks: { sourceKey } } });
}

function requireSource(req) {
  const sourceConfig = getSource(req.params.sourceKey);
  if (!sourceConfig) throw new HttpError(404, `Unknown source "${req.params.sourceKey}"`);
  return sourceConfig;
}

function serializeSecondary(doc) {
  return {
    id: doc._id,
    externalId: doc.externalId,
    name: doc.name,
    brand: doc.brand,
    address: doc.address,
    lat: doc.lat,
    lon: doc.lon,
    status: doc.status,
    fuelTypes: doc.fuelTypes,
    conflict: doc.conflict,
    lastSeenAt: doc.lastSeenAt,
    ignored: doc.ignored,
  };
}

// Lets the admin UI build a source-key selector (see StationMatchingView.vue)
// without hardcoding source names/labels - the single place a future source
// #3 becomes visible in this workflow is sourceRegistry.js's own list.
const listSourceOptions = asyncHandler(async (req, res) => {
  res.json(listSources().map((s) => ({ key: s.key, label: s.label })));
});

// Not paginated on purpose - "unmatched, needs review" is meant to trend
// toward zero as an admin works through it, unlike the station lists
// elsewhere in the app which cover every station indefinitely.
const UNMATCHED_LIMIT = 200;

const listUnmatched = asyncHandler(async (req, res) => {
  const sourceConfig = requireSource(req);
  const candidates = await sourceConfig.model
    .find({ matchedStationId: null, ignored: false })
    .sort({ lastSeenAt: -1 })
    .limit(UNMATCHED_LIMIT);

  const items = await Promise.all(
    candidates.map(async (doc) => ({
      ...serializeSecondary(doc),
      suggestions: (await stationMatchingService.suggestMatches(doc, sourceConfig.key)).map((s) => ({
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
  const sourceConfig = requireSource(req);
  const matches = await sourceConfig.model
    .find({ matchedStationId: { $ne: null } })
    .sort({ updatedAt: -1 })
    .populate('matchedStationId', 'name address lastStatus');

  res.json(
    matches.map((doc) => ({
      ...serializeSecondary(doc),
      station: doc.matchedStationId
        ? {
            id: doc.matchedStationId._id,
            name: doc.matchedStationId.name,
            address: doc.matchedStationId.address,
            lastStatus: doc.matchedStationId.lastStatus,
          }
        : null,
    }))
  );
});

const confirmMatch = asyncHandler(async (req, res) => {
  const sourceConfig = requireSource(req);
  const secondaryDoc = await sourceConfig.model.findById(req.params.id);
  if (!secondaryDoc) throw new HttpError(404, 'Station not found for this source');

  const { stationId } = req.body || {};
  if (!stationId) throw new HttpError(400, 'stationId is required');
  const station = await Station.findById(stationId);
  if (!station) throw new HttpError(404, 'Station not found');

  secondaryDoc.matchedStationId = station._id;
  secondaryDoc.ignored = false;
  await secondaryDoc.save();
  setSourceLink(station, sourceConfig.key, secondaryDoc._id);
  await station.save();

  // Apply immediately rather than waiting for the next poll tick, so the
  // admin sees the merged effect right away - the same write path
  // secondarySourceIngestService uses during ordinary ingestion, just
  // triggered by this confirmation instead of a fresh poll. Needs a Region
  // for the StationSnapshot it writes; any region the secondary source's
  // document was seen in works equally well here, since a snapshot's
  // `region` is just which poll loop produced it; the merged status itself
  // isn't region-specific.
  const region = await Region.findOne({ _id: { $in: secondaryDoc.regions } });
  if (region) {
    await secondarySourceIngestService.applyMergeToStation(station, region, new Date());
  }

  res.json({ ok: true });
});

const ignoreSecondary = asyncHandler(async (req, res) => {
  const sourceConfig = requireSource(req);
  const secondaryDoc = await sourceConfig.model.findById(req.params.id);
  if (!secondaryDoc) throw new HttpError(404, 'Station not found for this source');
  secondaryDoc.ignored = true;
  await secondaryDoc.save();
  res.json({ ok: true });
});

const unmatch = asyncHandler(async (req, res) => {
  const sourceConfig = requireSource(req);
  const secondaryDoc = await sourceConfig.model.findById(req.params.id);
  if (!secondaryDoc) throw new HttpError(404, 'Station not found for this source');

  if (secondaryDoc.matchedStationId) {
    await clearSourceLink(secondaryDoc.matchedStationId, sourceConfig.key);
  }
  secondaryDoc.matchedStationId = null;
  await secondaryDoc.save();
  res.json({ ok: true });
});

// The reverse entry point from listUnmatched: someone looking at one
// specific Station (the station-detail admin view) rather than working
// through a source's own unmatched queue, who wants to find/attach its
// counterpart in that source directly.
const suggestForStation = asyncHandler(async (req, res) => {
  const sourceConfig = requireSource(req);
  const station = await Station.findById(req.params.stationId, { name: 1, lat: 1, lon: 1 }).lean();
  if (!station) throw new HttpError(404, 'Station not found');
  const candidates = await stationMatchingService.suggestMatchesForStation(station, sourceConfig.key);
  res.json(candidates);
});

module.exports = {
  listSourceOptions,
  listUnmatched,
  listMatched,
  confirmMatch,
  ignoreSecondary,
  unmatch,
  suggestForStation,
};
