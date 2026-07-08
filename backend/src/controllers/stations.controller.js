const asyncHandler = require('../utils/asyncHandler');
const { HttpError } = require('../middleware/errorHandler');
const Station = require('../models/Station');
const StationSnapshot = require('../models/StationSnapshot');
const { getStationForecast } = require('../services/forecastService');

// Lightweight search used by the admin UI's station-watchlist picker (e.g.
// picking specific stations for a Telegram chat's subscription) - not meant
// for bulk listing, just narrowing down a name/address search within an
// optional region.
const listStations = asyncHandler(async (req, res) => {
  const query = {};
  if (req.query.region) query.regions = req.query.region;
  const q = (req.query.q || '').trim();
  if (q) {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'i');
    query.$or = [{ name: pattern }, { address: pattern }];
  }

  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const stations = await Station.find(query, { name: 1, address: 1, regions: 1 })
    .limit(limit)
    .lean();
  res.json(stations);
});

const getStation = asyncHandler(async (req, res) => {
  const station = await Station.findById(req.params.id);
  if (!station) throw new HttpError(404, 'Station not found');
  res.json(station);
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

  const limit = Math.min(Number(req.query.limit) || 500, 5000);
  const snapshots = await StationSnapshot.find(query)
    .select('-raw')
    .sort({ polledAt: 1 })
    .limit(limit);

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
