const asyncHandler = require('../utils/asyncHandler');
const { HttpError } = require('../middleware/errorHandler');
const Station = require('../models/Station');
const StationSnapshot = require('../models/StationSnapshot');
const { getStationForecast } = require('../services/forecastService');
const { getSource } = require('../services/sourceRegistry');

// Doubles as the admin UI's station-watchlist picker (small `q`+`limit`
// searches, the original use) and the "Станции" browse page's fuller list
// (region/status/matchState filters, a bigger limit, a richer projection) -
// same endpoint, same array response shape either way, so the original
// callers keep working unchanged with the extra fields simply unused.
const listStations = asyncHandler(async (req, res) => {
  const query = {};
  if (req.query.region) query.regions = req.query.region;
  if (req.query.status) query.lastStatus = req.query.status;
  // "matched"/"unmatched" here means "has any secondary source link at all"
  // (see Station.sourceLinks) - a per-source-key filter would need a real
  // 3rd source to be worth building; today there's only ever one anyway.
  if (req.query.matchState === 'matched') query['sourceLinks.0'] = { $exists: true };
  else if (req.query.matchState === 'unmatched') query['sourceLinks.0'] = { $exists: false };

  const q = (req.query.q || '').trim();
  if (q) {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'i');
    query.$or = [{ name: pattern }, { address: pattern }];
  }

  const limit = Math.min(Number(req.query.limit) || 20, 500);
  const stations = await Station.find(query, {
    name: 1,
    address: 1,
    regions: 1,
    lat: 1,
    lon: 1,
    lastStatus: 1,
    lastSeenAt: 1,
    sourceLinks: 1,
  })
    .sort({ name: 1 })
    .limit(limit)
    .lean();
  res.json(stations);
});

const getStation = asyncHandler(async (req, res) => {
  const station = await Station.findById(req.params.id).lean();
  if (!station) throw new HttpError(404, 'Station not found');

  // tbankLastStatus/tbankLastFuelStatuses were added to the schema after
  // stations already existed in the database - a document last written
  // before that change simply doesn't have these keys yet (Mongo doesn't
  // retroactively add fields, and .lean() skips Mongoose's own document
  // hydration, which is the only place schema defaults get applied), so
  // they'd otherwise come back as undefined and get dropped by
  // JSON.stringify entirely - the frontend would then show a misleading
  // "нет данных" for a station that actually has real tbank data.
  // For any station that has never been matched to a secondary source,
  // lastStatus/lastFuelStatuses ARE tbank's own unblended reading by
  // construction (nothing else has ever written to them), so falling back
  // to those reproduces exactly what tbankLastStatus will say once a fresh
  // tbank poll repopulates it for real. A station that IS matched but
  // predates the field genuinely has no clean unmerged reading to fall back
  // to - that narrow case just shows "нет данных" until its next poll.
  const hasAnySourceLink = (station.sourceLinks || []).length > 0;
  if (station.tbankLastStatus === undefined) {
    station.tbankLastStatus = hasAnySourceLink ? 'no_data' : station.lastStatus;
  }
  if (station.tbankLastFuelStatuses === undefined) {
    station.tbankLastFuelStatuses = hasAnySourceLink ? [] : station.lastFuelStatuses;
  }
  if (station.tbankLastSeenAt === undefined) {
    station.tbankLastSeenAt = hasAnySourceLink ? null : station.lastSeenAt;
  }

  // Enriches the same response the map/reports' StationDetailModal already
  // consumes (an extra `sources` property is simply unused by any caller
  // that doesn't ask for it) rather than adding a second endpoint - the
  // admin station-detail view needs every matched source's own reading
  // (untouched by the merge, see mergeStatusService.js) to show side by
  // side with tbank's own and the merged result. One entry per currently-
  // linked secondary source (see services/sourceRegistry.js), replacing the
  // single hardcoded `gdebenz` key this endpoint used to return.
  const sources = [];
  for (const link of station.sourceLinks || []) {
    const sourceConfig = getSource(link.sourceKey);
    if (!sourceConfig) continue; // an unregistered/removed source's stale link
    const doc = await sourceConfig.model.findById(link.refId).lean();
    if (!doc) continue;
    sources.push({
      key: sourceConfig.key,
      label: sourceConfig.label,
      id: doc._id,
      name: doc.name,
      brand: doc.brand,
      address: doc.address,
      lat: doc.lat,
      lon: doc.lon,
      status: doc.status,
      fuelTypes: doc.fuelTypes,
      conflict: doc.conflict,
      lastSeenAt: doc.lastSeenAt,
    });
  }

  res.json({ ...station, sources });
});

const getStationHistory = asyncHandler(async (req, res) => {
  const station = await Station.findById(req.params.id);
  if (!station) throw new HttpError(404, 'Station not found');

  const query = { station: station._id };
  if (req.query.from || req.query.to) {
    query.polledAt = {};
    if (req.query.from) query.polledAt.$gte = new Date(req.query.from);
    if (req.query.to) query.polledAt.$lte = new Date(req.query.to);
  }

  // Sort descending to grab the *most recent* `limit` snapshots (the common
  // case: no from/to, just "recent history for a card/chart") - sorting
  // ascending-then-limit would instead keep the oldest ones whenever a
  // station has more history than `limit`, silently dropping everything
  // since. Reversed back to chronological order before responding, since
  // every consumer (StationHistoryChart.vue, stationCard.js) expects
  // oldest -> newest.
  const limit = Math.min(Number(req.query.limit) || 500, 5000);
  const snapshots = await StationSnapshot.find(query)
    .select('-raw')
    .sort({ polledAt: -1 })
    .limit(limit);
  snapshots.reverse();

  res.json(snapshots);
});

const getForecast = asyncHandler(async (req, res) => {
  const station = await Station.findById(req.params.id);
  if (!station) throw new HttpError(404, 'Station not found');

  const hoursAhead = Math.min(Math.max(Number(req.query.hoursAhead) || 24, 1), 72);
  const lookbackDays = Math.min(Math.max(Number(req.query.lookbackDays) || 28, 1), 180);
  const tz = req.query.tz || undefined;

  const forecast = await getStationForecast(station._id, { hoursAhead, lookbackDays, tz });
  res.json(forecast);
});

module.exports = { listStations, getStation, getStationHistory, getForecast };
