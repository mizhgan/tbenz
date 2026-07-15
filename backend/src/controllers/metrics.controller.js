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

// Matches metricsService.js's own METRICS_CACHE_TTL_MS and this file's own
// Cache-Control max-age below - both were already built assuming requests
// within the same 5-minute window would share a cache entry, but the
// reports page always sends a fresh millisecond-precision "now" as `to`
// (and, transitively, a fresh `from`), so every single page load got its
// own unique cache key and neither cache ever actually hit for real
// traffic - measured live, a cold getStationMetrics call over a 7-day/
// 101-station region takes ~2.7s, every time, for every visitor. Rounding
// both endpoints down to this boundary means every visitor within the same
// window shares one cached computation instead.
const RANGE_ROUND_MS = 5 * 60 * 1000;

function roundDown(date) {
  return new Date(Math.floor(date.getTime() / RANGE_ROUND_MS) * RANGE_ROUND_MS);
}

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
  const roundedFrom = roundDown(from);
  const roundedTo = roundDown(to);
  // Only every requested range on this app is at least 24h (the reports
  // page's shortest preset) - rounding both down by up to RANGE_ROUND_MS
  // each can't realistically collapse one, but this guards the
  // theoretical edge case (a very short custom range straddling one
  // rounding bucket) by falling back to the exact, unrounded values rather
  // than ever returning an inverted or empty range.
  if (roundedFrom >= roundedTo) return { from, to };
  return { from: roundedFrom, to: roundedTo };
}

function parseBucketHours(query) {
  if (query.bucketHours === undefined) return 24;
  const hours = Number(query.bucketHours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 31) {
    throw new HttpError(400, 'bucketHours must be an integer between 1 and 744');
  }
  return hours;
}

// Matches metricsService.js's own METRICS_CACHE_TTL_MS (5 min, the same
// value its in-process memoizeAsync caching already uses) - lets a browser
// or any intermediary cache skip the round-trip entirely within that
// window, on top of the server-side cache already saving the Mongo work.
const METRICS_MAX_AGE = 'public, max-age=300';

const getTrend = asyncHandler(async (req, res) => {
  const regionId = new mongoose.Types.ObjectId(req.params.id);
  const { from, to } = parseRange(req.query);
  const bucketHours = parseBucketHours(req.query);
  const tz = req.query.tz || undefined;
  const buckets = await metricsService.getAvailabilityTrend(regionId, { from, to, bucketHours, tz });
  res.set('Cache-Control', METRICS_MAX_AGE);
  res.json({ from, to, bucketHours, buckets });
});

const getStations = asyncHandler(async (req, res) => {
  const regionId = new mongoose.Types.ObjectId(req.params.id);
  const { from, to } = parseRange(req.query);
  const stations = await metricsService.getStationMetrics(regionId, { from, to });
  res.set('Cache-Control', METRICS_MAX_AGE);
  res.json({ from, to, stations });
});

const getBrands = asyncHandler(async (req, res) => {
  const regionId = new mongoose.Types.ObjectId(req.params.id);
  const { from, to } = parseRange(req.query);
  const brands = await metricsService.getBrandMetrics(regionId, { from, to });
  res.set('Cache-Control', METRICS_MAX_AGE);
  res.json({ from, to, brands });
});

const getHeatmap = asyncHandler(async (req, res) => {
  const regionId = new mongoose.Types.ObjectId(req.params.id);
  const { from, to } = parseRange(req.query);
  const tz = req.query.tz || undefined;
  const cells = await metricsService.getHeatmap(regionId, { from, to, tz });
  res.set('Cache-Control', METRICS_MAX_AGE);
  res.json({ from, to, cells });
});

const getRecoveryTrend = asyncHandler(async (req, res) => {
  const regionId = new mongoose.Types.ObjectId(req.params.id);
  const { from, to } = parseRange(req.query);
  const bucketHours = parseBucketHours(req.query);
  const buckets = await metricsService.getRecoveryTrend(regionId, { from, to, bucketHours });
  res.set('Cache-Control', METRICS_MAX_AGE);
  res.json({ from, to, bucketHours, buckets });
});

const getTrendForecast = asyncHandler(async (req, res) => {
  const regionId = new mongoose.Types.ObjectId(req.params.id);
  const { from, to } = parseRange(req.query);
  const bucketHours = parseBucketHours(req.query);
  const tz = req.query.tz || undefined;

  const bucketsAhead = Math.min(Math.max(Number(req.query.bucketsAhead) || 6, 1), 30);

  const result = await getRegionTrendForecast(regionId, { from, to, bucketHours, bucketsAhead, tz });
  res.set('Cache-Control', METRICS_MAX_AGE);
  res.json({ from, to, bucketHours, ...result });
});

module.exports = { getTrend, getStations, getBrands, getHeatmap, getRecoveryTrend, getTrendForecast };
