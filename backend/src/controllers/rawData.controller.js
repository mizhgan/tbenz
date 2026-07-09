const asyncHandler = require('../utils/asyncHandler');
const { HttpError } = require('../middleware/errorHandler');
const Region = require('../models/Region');
const Station = require('../models/Station');
const GdebenzStation = require('../models/GdebenzStation');
const StationSnapshot = require('../models/StationSnapshot');

// Deliberately a small, explicit whitelist - this exists purely so an admin
// can pull real examples of stored data for debugging (e.g. checking
// whether two same-looking stations really do have different `externalId`
// values), not as a general database browser. User/Proxy are excluded
// entirely: those collections carry credentials (password hashes, proxy
// auth) that have no business being retrievable as raw JSON, debugging
// need or not.
const COLLECTIONS = {
  regions: Region,
  stations: Station,
  gdebenzStations: GdebenzStation,
  stationSnapshots: StationSnapshot,
};

const MAX_LIMIT = 200;

// Blocks operators that can run arbitrary server-side JS or write/rename
// data - defense in depth beyond "only admins can reach this route" (see
// requireAdmin on the router), since a filter string here is still
// attacker-shaped input even when the attacker is a trusted role.
const FORBIDDEN_KEYS = new Set(['$where', '$function', '$accumulator', '$out', '$merge']);
function assertSafeFilter(value) {
  if (Array.isArray(value)) {
    value.forEach(assertSafeFilter);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new HttpError(400, `Оператор ${key} запрещён`);
      }
      assertSafeFilter(nested);
    }
  }
}

const listCollections = asyncHandler(async (req, res) => {
  res.json(Object.keys(COLLECTIONS));
});

const queryCollection = asyncHandler(async (req, res) => {
  const Model = COLLECTIONS[req.params.collection];
  if (!Model) throw new HttpError(404, 'Unknown collection');

  let filter = {};
  if (req.query.filter) {
    try {
      filter = JSON.parse(req.query.filter);
    } catch (err) {
      throw new HttpError(400, 'filter must be valid JSON');
    }
  }
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
    throw new HttpError(400, 'filter must be a JSON object');
  }
  assertSafeFilter(filter);

  const limit = Math.min(Number(req.query.limit) || 20, MAX_LIMIT);
  const docs = await Model.find(filter).sort({ _id: -1 }).limit(limit).lean();
  res.json({ count: docs.length, docs });
});

// Surfaces exactly the situation that led to the yandexOrgId dedupe fix
// (see ingestService.storeStation): several Station documents sharing the
// same yandexOrgId are the same physical station that got split into
// duplicates before that fix, or - now that new duplicates should no longer
// form - a sign the yandexOrgId assumption doesn't hold for some station
// after all. No filter input here (unlike queryCollection above), so
// there's nothing to sanitize - it always runs the same fixed aggregation.
const findDuplicateStations = asyncHandler(async (req, res) => {
  const groups = await Station.aggregate([
    { $match: { yandexOrgId: { $ne: null } } },
    {
      $project: {
        name: 1,
        address: 1,
        lat: 1,
        lon: 1,
        externalId: 1,
        yandexOrgId: 1,
        firstSeenAt: 1,
        lastSeenAt: 1,
        lastStatus: 1,
        gdebenzStationId: 1,
      },
    },
    { $sort: { firstSeenAt: 1 } },
    { $group: { _id: '$yandexOrgId', count: { $sum: 1 }, stations: { $push: '$$ROOT' } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
  ]);
  res.json({ count: groups.length, groups });
});

module.exports = { listCollections, queryCollection, findDuplicateStations };
