const mongoose = require('mongoose');
const asyncHandler = require('../utils/asyncHandler');
const { HttpError } = require('../middleware/errorHandler');
const Region = require('../models/Region');
const Station = require('../models/Station');
const StationSnapshot = require('../models/StationSnapshot');
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

const listRegions = asyncHandler(async (req, res) => {
  const regions = await Region.find().sort({ createdAt: -1 });
  res.json(regions);
});

const getRegion = asyncHandler(async (req, res) => {
  const region = await Region.findById(req.params.id);
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

const getHistoryRange = asyncHandler(async (req, res) => {
  const regionId = new mongoose.Types.ObjectId(req.params.id);
  const [range] = await StationSnapshot.aggregate([
    { $match: { region: regionId } },
    { $group: { _id: null, min: { $min: '$polledAt' }, max: { $max: '$polledAt' } } },
  ]);
  res.json({ from: range?.min ?? null, to: range?.max ?? null });
});

const getRegionSnapshot = asyncHandler(async (req, res) => {
  const regionId = new mongoose.Types.ObjectId(req.params.id);
  const at = req.query.at ? new Date(req.query.at) : new Date();
  if (Number.isNaN(at.getTime())) {
    throw new HttpError(400, 'Invalid "at" timestamp');
  }

  const stations = await StationSnapshot.aggregate([
    { $match: { region: regionId, polledAt: { $lte: at } } },
    { $sort: { station: 1, polledAt: -1 } },
    { $group: { _id: '$station', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } },
    {
      $lookup: {
        from: 'stations',
        localField: 'station',
        foreignField: '_id',
        as: 'stationInfo',
      },
    },
    { $unwind: '$stationInfo' },
    {
      $project: {
        _id: 0,
        stationId: '$station',
        polledAt: 1,
        lat: 1,
        lon: 1,
        fuels: 1,
        name: '$stationInfo.name',
        brand: '$stationInfo.brand',
        address: '$stationInfo.address',
      },
    },
  ]);

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
  getRegionSnapshot,
};
