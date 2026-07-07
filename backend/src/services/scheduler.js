const Region = require('../models/Region');
const { ingestRegion } = require('./ingestService');
const logger = require('../utils/logger');

// regionId (string) -> interval handle
const timers = new Map();

async function runPoll(regionId) {
  const region = await Region.findById(regionId);
  if (!region || !region.active) {
    unscheduleRegion(regionId);
    return;
  }
  try {
    await ingestRegion(region);
  } catch (err) {
    // Already logged/persisted inside ingestRegion; swallow here so the
    // interval keeps running on the next tick.
  }
}

function unscheduleRegion(regionId) {
  const key = String(regionId);
  const handle = timers.get(key);
  if (handle) {
    clearInterval(handle);
    timers.delete(key);
  }
}

function scheduleRegion(region, { runImmediately = true } = {}) {
  const key = String(region._id);
  unscheduleRegion(key);

  if (!region.active) return;

  const intervalMs = Math.max(1, region.pollIntervalMinutes) * 60 * 1000;
  const handle = setInterval(() => runPoll(key), intervalMs);
  timers.set(key, handle);
  logger.info(`Scheduled region "${region.name}" every ${region.pollIntervalMinutes} min`);

  if (runImmediately) {
    runPoll(key);
  }
}

async function rescheduleRegion(regionId) {
  const region = await Region.findById(regionId);
  if (!region) {
    unscheduleRegion(regionId);
    return;
  }
  scheduleRegion(region, { runImmediately: false });
}

async function start() {
  const regions = await Region.find({ active: true });
  for (const region of regions) {
    scheduleRegion(region, { runImmediately: false });
  }
  logger.info(`Scheduler started with ${regions.length} active region(s)`);
}

function stopAll() {
  for (const handle of timers.values()) clearInterval(handle);
  timers.clear();
}

module.exports = {
  start,
  stopAll,
  scheduleRegion,
  rescheduleRegion,
  unscheduleRegion,
  pollNow: runPoll,
};
