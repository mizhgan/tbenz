const mongoose = require('mongoose');
const asyncHandler = require('../utils/asyncHandler');
const { HttpError } = require('../middleware/errorHandler');
const metricsService = require('../services/metricsService');
const { getRegionTrendForecast } = require('../services/forecastService');

const DEFAULT_RANGE_MS = 7 * 24 * 60 * 60 * 1000;
// A wide-open range forces the metrics queries to scan and, for
// getStationMetrics, materialize every raw snapshot in the window in
// memory - unbounded on a low-memory host. 92 days comfortably covers the
// reports page's own presets (up to 30 days) with headroom.
const MAX_RANGE_MS = 92 * 24 * 60 * 60 * 1000;

function parseRange(query) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - DEFAULT_RANGE_MS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new HttpError(400, 'Invalid "from"/"to" timestamp');
  }
  if (from >= to) {
    throw new HttpError(400, '"from" must be before "to"');
  }
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
    throw new HttpError(400, `Range too wide - max ${MAX_RANGE_MS / (24 * 60 * 60 * 1000)} days`);
  }
  return { from, to };
}

function parseBucketHours(query) {
  if (query.bucketHours === undefined) return 24;
  const hours = Number(query.bucketHours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 31) {
    throw new HttpError(400, 'bucketHours must be an integer between 1 and 744');
  }
  return hours;
}

const getTrend = asyncHandler(async (req, res) => {
  const regionId = new mongoose.Types.ObjectId(req.params.id);
  const { from, to } = parseRange(req.query);
  const bucketHours = parseBucketHours(req.query);
  const tz = req.query.tz || undefined;
  const buckets = await metricsService.getAvailabilityTrend(regionId, { from, to, bucketHours, tz });
  res.json({ from, to, bucketHours, buckets });
});

const getStations = asyncHandler(async (req, res) => {
  const regionId = new mongoose.Types.ObjectId(req.params.id);
  const { from, to } = parseRange(req.query);
  const stations = await metricsService.getStationMetrics(regionId, { from, to });
  res.json({ from, to, stations });
});

const getBrands = asyncHandler(async (req, res) => {
  const regionId = new mongoose.Types.ObjectId(req.params.id);
  const { from, to } = parseRange(req.query);
  const brands = await metricsService.getBrandMetrics(regionId, { from, to });
  res.json({ from, to, brands });
});

const getHeatmap = asyncHandler(async (req, res) => {
  const regionId = new mongoose.Types.ObjectId(req.params.id);
  const { from, to } = parseRange(req.query);
  const tz = req.query.tz || undefined;
  const cells = await metricsService.getHeatmap(regionId, { from, to, tz });
  res.json({ from, to, cells });
});

const getTrendForecast = asyncHandler(async (req, res) => {
  const regionId = new mongoose.Types.ObjectId(req.params.id);
  const { from, to } = parseRange(req.query);
  const bucketHours = parseBucketHours(req.query);
  const tz = req.query.tz || undefined;

  const bucketsAhead = Math.min(Math.max(Number(req.query.bucketsAhead) || 6, 1), 30);

  const result = await getRegionTrendForecast(regionId, { from, to, bucketHours, bucketsAhead, tz });
  res.json({ from, to, bucketHours, ...result });
});

module.exports = { getTrend, getStations, getBrands, getHeatmap, getTrendForecast };
