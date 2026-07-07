const { fetchStations } = require('./tbankClient');
const { extractStationsArray, parseStation } = require('./stationParser');
const Station = require('../models/Station');
const StationSnapshot = require('../models/StationSnapshot');
const logger = require('../utils/logger');

async function storeStation(parsed, region, polledAt) {
  const station = await Station.findOneAndUpdate(
    { externalId: parsed.externalId },
    {
      $set: {
        name: parsed.name,
        address: parsed.address,
        lat: parsed.lat,
        lon: parsed.lon,
        yandexOrgId: parsed.yandexOrgId,
        lastSeenAt: polledAt,
        lastStatus: parsed.status,
        lastFuelStatuses: parsed.fuelStatuses,
        lastTransactionAt: parsed.lastTransactionAt,
        lastRaw: parsed.raw,
      },
      $setOnInsert: { firstSeenAt: polledAt },
      $addToSet: { regions: region._id },
    },
    { upsert: true, new: true }
  );

  await StationSnapshot.create({
    station: station._id,
    region: region._id,
    polledAt,
    lat: parsed.lat,
    lon: parsed.lon,
    status: parsed.status,
    fuelStatuses: parsed.fuelStatuses,
    lastTransactionAt: parsed.lastTransactionAt,
    raw: parsed.raw,
  });
}

/**
 * Fetches current stations for a region's bounding box and appends a new
 * historical snapshot per station. Always updates the region's poll status,
 * even on failure, so the admin UI can surface it.
 */
async function ingestRegion(region) {
  const polledAt = new Date();
  try {
    const payload = await fetchStations({
      minLat: region.minLat,
      maxLat: region.maxLat,
      minLon: region.minLon,
      maxLon: region.maxLon,
    });
    const rawStations = extractStationsArray(payload);

    let stored = 0;
    let skipped = 0;
    for (const raw of rawStations) {
      const parsed = parseStation(raw);
      if (!parsed) {
        skipped += 1;
        continue;
      }
      try {
        await storeStation(parsed, region, polledAt);
        stored += 1;
      } catch (err) {
        logger.error(`Failed to store station for region ${region.name}:`, err.message);
      }
    }

    region.lastPolledAt = polledAt;
    region.lastPollStatus = 'ok';
    region.lastPollError = null;
    region.lastPollStationCount = stored;
    await region.save();

    if (skipped > 0) {
      logger.warn(
        `Region "${region.name}": skipped ${skipped} station(s) with unrecognized shape`
      );
    }
    logger.info(`Region "${region.name}": stored ${stored} station snapshot(s)`);
    return { stationCount: stored, skipped };
  } catch (err) {
    region.lastPolledAt = polledAt;
    region.lastPollStatus = 'error';
    region.lastPollError = err.message;
    await region.save();
    logger.error(`Region "${region.name}": poll failed:`, err.message);
    throw err;
  }
}

module.exports = { ingestRegion };
