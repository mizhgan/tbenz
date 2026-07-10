const mongoose = require('mongoose');
const asyncHandler = require('../utils/asyncHandler');
const { HttpError } = require('../middleware/errorHandler');
const Region = require('../models/Region');
const Station = require('../models/Station');
const StationSnapshot = require('../models/StationSnapshot');
const SourcePollLog = require('../models/SourcePollLog');
const metricsService = require('../services/metricsService');
const pollLogService = require('../services/pollLogService');
const scheduler = require('../services/scheduler');
const { ingestRegion } = require('../services/ingestService');
const { minPollIntervalMinutes } = require('../config/env');

function validateRegionInput(body, { partial = false } = {}) {
  const out = {};
  const fields = ['name', 'minLat', 'maxLat', 'minLon', 'maxLon', 'pollIntervalMinutes', 'active'];

  for (const field of fields) {
    if (body[field] !== undefined) out[field] = body[field];
  }

  if (!partial || out.name !== undefined) {
    if (typeof out.name !== 'string' || !out.name.trim()) {
      throw new HttpError(400, 'name is required');
    }
    out.name = out.name.trim();
  }

  for (const field of ['minLat', 'maxLat', 'minLon', 'maxLon']) {
    if (!partial || out[field] !== undefined) {
      const num = Number(out[field]);
      if (!Number.isFinite(num)) {
        throw new HttpError(400, `${field} must be a number`);
      }
      out[field] = num;
    }
  }

  if (out.minLat !== undefined && out.maxLat !== undefined && out.minLat >= out.maxLat) {
    throw new HttpError(400, 'minLat must be less than maxLat');
  }
  if (out.minLon !== undefined && out.maxLon !== undefined && out.minLon >= out.maxLon) {
    throw new HttpError(400, 'minLon must be less than maxLon');
  }

  if (out.pollIntervalMinutes !== undefined) {
    const num = Number(out.pollIntervalMinutes);
    if (!Number.isFinite(num) || num < minPollIntervalMinutes) {
      throw new HttpError(400, `pollIntervalMinutes must be a number >= ${minPollIntervalMinutes}`);
    }
    out.pollIntervalMinutes = num;
  }

  if (out.active !== undefined) {
    out.active = Boolean(out.active);
  }

  return out;
}

// Raw response bodies (lastRawResponse / sourcePollStatus[].rawResponse) are
// excluded here and from getRegion below - the Regions admin page polls
// these every 15s, and a raw payload can be sizeable (see
// utils/rawResponseCap.js); fetched on demand instead via
// GET /regions/:id/raw-response. requestUrl (a short string) stays included
// so the "copy URL" button works without an extra round-trip.
const RAW_RESPONSE_EXCLUDE = '-lastRawResponse -sourcePollStatus.rawResponse';

// An anonymous visitor (the public map/reports pages, see optionalAuth on
// these routes) gets this instead - on top of RAW_RESPONSE_EXCLUDE, also
// drops every operationally-sensitive poll-status field (scraper target
// URLs, source error text, poll timestamps/counts) that has no business
// going to the public internet. bbox/name/active/pollIntervalMinutes stay -
// not sensitive, and the map/reports pages only ever read `_id`/`name`
// anyway. Logged-in callers (any role) keep getting RAW_RESPONSE_EXCLUDE's
// full set unchanged, since RegionsView.vue reads sourcePollStatus/
// lastPollStatus/lastRequestUrl directly off this same response.
const PUBLIC_REGION_EXCLUDE =
  '-lastRawResponse -sourcePollStatus -lastPollStatus -lastPollError -lastPollStationCount -lastRequestUrl -lastPolledAt';

const listRegions = asyncHandler(async (req, res) => {
  const select = req.user ? RAW_RESPONSE_EXCLUDE : PUBLIC_REGION_EXCLUDE;
  const regions = await Region.find().select(select).sort({ createdAt: -1 });
  res.json(regions);
});

const getRegion = asyncHandler(async (req, res) => {
  const select = req.user ? RAW_RESPONSE_EXCLUDE : PUBLIC_REGION_EXCLUDE;
  const region = await Region.findById(req.params.id).select(select);
  if (!region) throw new HttpError(404, 'Region not found');
  res.json(region);
});

const createRegion = asyncHandler(async (req, res) => {
  const data = validateRegionInput(req.body);
  const region = await Region.create({
    name: data.name,
    minLat: data.minLat,
    maxLat: data.maxLat,
    minLon: data.minLon,
    maxLon: data.maxLon,
    pollIntervalMinutes: data.pollIntervalMinutes ?? 10,
    active: data.active ?? true,
  });
  scheduler.scheduleRegion(region, { runImmediately: true });
  res.status(201).json(region);
});

const updateRegion = asyncHandler(async (req, res) => {
  const region = await Region.findById(req.params.id);
  if (!region) throw new HttpError(404, 'Region not found');

  const data = validateRegionInput(req.body, { partial: true });
  Object.assign(region, data);
  await region.save();

  if (region.active) {
    scheduler.scheduleRegion(region, { runImmediately: false });
  } else {
    scheduler.unscheduleRegion(region._id);
  }

  res.json(region);
});

const deleteRegion = asyncHandler(async (req, res) => {
  const region = await Region.findById(req.params.id);
  if (!region) throw new HttpError(404, 'Region not found');

  scheduler.unscheduleRegion(region._id);
  await StationSnapshot.deleteMany({ region: region._id });
  await SourcePollLog.deleteMany({ region: region._id });
  await Station.updateMany({ regions: region._id }, { $pull: { regions: region._id } });
  await region.deleteOne();

  res.status(204).end();
});

const pollRegionNow = asyncHandler(async (req, res) => {
  const region = await Region.findById(req.params.id);
  if (!region) throw new HttpError(404, 'Region not found');
  const result = await ingestRegion(region);
  res.json({ ok: true, ...result });
});

// 24h attempt/error counts per source (tbank + every registered secondary
// source) - see pollLogService.js's doc comment for why this needs its own
// log instead of reading Region.lastPollStatus/sourcePollStatus, which only
// ever holds the single latest attempt.
const getPollStats = asyncHandler(async (req, res) => {
  const region = await Region.findById(req.params.id);
  if (!region) throw new HttpError(404, 'Region not found');
  const stats = await pollLogService.getPollStats(region._id);
  res.json(stats);
});

const getPollLogs = asyncHandler(async (req, res) => {
  const region = await Region.findById(req.params.id);
  if (!region) throw new HttpError(404, 'Region not found');
  const sourceKey = req.query.sourceKey;
  if (!sourceKey) throw new HttpError(400, 'sourceKey is required');
  const limit = Number(req.query.limit) || 50;
  const logs = await pollLogService.getRecentLogs(region._id, sourceKey, { limit });
  res.json(logs);
});

// The one field deliberately left out of listRegions/getRegion above -
// fetched on its own, on demand, when an admin actually wants to inspect a
// source's last raw response.
const getRawResponse = asyncHandler(async (req, res) => {
  const sourceKey = req.query.sourceKey;
  if (!sourceKey) throw new HttpError(400, 'sourceKey is required');

  if (sourceKey === 'tbank') {
    const region = await Region.findById(req.params.id, { lastRequestUrl: 1, lastRawResponse: 1, lastPolledAt: 1 });
    if (!region) throw new HttpError(404, 'Region not found');
    return res.json({
      requestUrl: region.lastRequestUrl,
      rawResponse: region.lastRawResponse,
      capturedAt: region.lastPolledAt,
    });
  }

  const region = await Region.findById(req.params.id, { sourcePollStatus: 1 });
  if (!region) throw new HttpError(404, 'Region not found');
  const entry = region.sourcePollStatus.find((s) => s.sourceKey === sourceKey);
  if (!entry) throw new HttpError(404, 'No poll data for this source yet');
  res.json({ requestUrl: entry.requestUrl, rawResponse: entry.rawResponse, capturedAt: entry.lastPolledAt });
});

const getHistoryRange = asyncHandler(async (req, res) => {
  const regionId = new mongoose.Types.ObjectId(req.params.id);
  const [range] = await StationSnapshot.aggregate([
    { $match: { region: regionId } },
    { $group: { _id: null, min: { $min: '$polledAt' }, max: { $max: '$polledAt' } } },
  ]);
  res.json({ from: range?.min ?? null, to: range?.max ?? null });
});

// Distinct poll moments actually stored for this region within a range - a
// single ingestRegion() run stamps every station's snapshot with the same
// polledAt, so this is exactly the set of "frames" that really exist,
// useful for building an animation from real data instead of interpolating
// at arbitrary evenly-spaced timestamps.
const getSnapshotTimes = asyncHandler(async (req, res) => {
  const regionId = new mongoose.Types.ObjectId(req.params.id);
  const match = { region: regionId };
  if (req.query.from || req.query.to) {
    match.polledAt = {};
    if (req.query.from) match.polledAt.$gte = new Date(req.query.from);
    if (req.query.to) match.polledAt.$lte = new Date(req.query.to);
  }
  const times = await StationSnapshot.distinct('polledAt', match);
  times.sort((a, b) => a - b);
  res.json({ times });
});

const LIVE_SNAPSHOT_BUCKET_MS = 60 * 1000;

const getRegionSnapshot = asyncHandler(async (req, res) => {
  const regionId = new mongoose.Types.ObjectId(req.params.id);

  let at;
  if (req.query.at) {
    at = new Date(req.query.at);
    if (Number.isNaN(at.getTime())) throw new HttpError(400, 'Invalid "at" timestamp');
  } else {
    // Live case (no explicit `at`, the map's own live-mode polling) -
    // rounded to a 60s boundary so repeated polls within the same window
    // share one cached aggregation (see metricsService.getCurrentSnapshot)
    // instead of each recomputing the map's live view from scratch. The
    // underlying data only actually changes on each ~10-15 min real poll
    // tick anyway, so a request landing up to a minute "in the past" is
    // never stale in any way a viewer could notice.
    at = new Date(Math.floor(Date.now() / LIVE_SNAPSHOT_BUCKET_MS) * LIVE_SNAPSHOT_BUCKET_MS);
  }

  const stations = await metricsService.getCurrentSnapshot(regionId, at);
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ at, stations });
});

module.exports = {
  listRegions,
  getRegion,
  createRegion,
  updateRegion,
  deleteRegion,
  pollRegionNow,
  getHistoryRange,
  getSnapshotTimes,
  getRegionSnapshot,
  getPollStats,
  getPollLogs,
  getRawResponse,
};
