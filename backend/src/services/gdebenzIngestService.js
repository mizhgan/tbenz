const { fetchStations } = require('./gdebenzClient');
const { extractGdebenzStationsArray, parseGdebenzStation } = require('./gdebenzParser');
const { gdebenzEnabled } = require('../config/env');
const GdebenzStation = require('../models/GdebenzStation');
const Station = require('../models/Station');
const StationSnapshot = require('../models/StationSnapshot');
const { mergeFuelStatuses, mergeOverallStatus } = require('./mergeStatusService');
const telegramNotifier = require('./telegramNotifier');
const logger = require('../utils/logger');

async function storeGdebenzStation(parsed, region, polledAt) {
  return GdebenzStation.findOneAndUpdate(
    { externalId: parsed.externalId },
    {
      $set: {
        name: parsed.name,
        brand: parsed.brand,
        address: parsed.address,
        lat: parsed.lat,
        lon: parsed.lon,
        lastSeenAt: polledAt,
        status: parsed.status,
        fuelTypes: parsed.fuelTypes,
        conflict: parsed.conflict,
        lastRaw: parsed.raw,
      },
      $setOnInsert: { firstSeenAt: polledAt },
      $addToSet: { regions: region._id },
    },
    { upsert: true, new: true }
  );
}

/**
 * Recomputes and writes the merged status for a Station confirmed-matched to
 * a gdebenz station, after that gdebenz station's own reading was just
 * stored. Writes to the exact same fields ingestService.storeStation does
 * for a tbank poll, and appends a StationSnapshot the same way - so from
 * every other consumer's point of view (metrics, reports, forecasts,
 * Telegram) this looks like an ordinary poll, not a second data source.
 */
async function applyMergeToStation(station, gdebenzStation, region, polledAt) {
  const previousFuelStatuses = station.lastFuelStatuses;
  const mergedFuelStatuses = mergeFuelStatuses(
    station.lastFuelStatuses,
    gdebenzStation.status,
    gdebenzStation.fuelTypes
  );
  const mergedStatus = mergeOverallStatus(station.lastStatus, gdebenzStation.status);

  station.lastStatus = mergedStatus;
  station.lastFuelStatuses = mergedFuelStatuses;
  station.lastSeenAt = polledAt;
  await station.save();

  await StationSnapshot.create({
    station: station._id,
    region: region._id,
    polledAt,
    lat: station.lat,
    lon: station.lon,
    status: mergedStatus,
    fuelStatuses: mergedFuelStatuses,
    lastTransactionAt: station.lastTransactionAt,
    raw: { mergedFromGdebenzStationId: gdebenzStation._id, gdebenzRaw: gdebenzStation.lastRaw },
  });

  return telegramNotifier.computeTransitions(previousFuelStatuses, mergedFuelStatuses);
}

/**
 * Fetches gdebenz stations for a region's bounding box (same bbox as tbank),
 * upserts each into GdebenzStation, and for any that are already
 * admin-confirmed matches to a Station, folds the new reading into that
 * Station via applyMergeToStation. Mirrors ingestService.ingestRegion's own
 * shape (per-region poll-status bookkeeping, best-effort Telegram notify) so
 * a gdebenz-specific problem is visible the same way a tbank one would be,
 * without ever being able to break tbank ingestion itself - see the
 * try/catch around this call in ingestService.ingestRegion.
 */
async function ingestGdebenzRegion(region) {
  if (!gdebenzEnabled) return { stationCount: 0, skipped: 0 };

  const polledAt = new Date();
  try {
    const payload = await fetchStations({
      minLat: region.minLat,
      maxLat: region.maxLat,
      minLon: region.minLon,
      maxLon: region.maxLon,
    });
    const rawStations = extractGdebenzStationsArray(payload);

    let stored = 0;
    let skipped = 0;
    const stationEvents = [];
    for (const raw of rawStations) {
      const parsed = parseGdebenzStation(raw);
      if (!parsed) {
        skipped += 1;
        continue;
      }
      try {
        const gdebenzStation = await storeGdebenzStation(parsed, region, polledAt);
        stored += 1;

        if (gdebenzStation.matchedStationId) {
          const station = await Station.findById(gdebenzStation.matchedStationId);
          if (station) {
            const transitions = await applyMergeToStation(station, gdebenzStation, region, polledAt);
            if (transitions.length) stationEvents.push({ station, transitions });
          }
        }
      } catch (err) {
        logger.error(`Failed to store gdebenz station for region ${region.name}:`, err.message);
      }
    }

    region.lastGdebenzPolledAt = polledAt;
    region.lastGdebenzPollStatus = 'ok';
    region.lastGdebenzPollError = null;
    region.lastGdebenzPollStationCount = stored;
    await region.save();

    try {
      await telegramNotifier.notifyRegionChanges(region, stationEvents);
    } catch (err) {
      logger.error(`Telegram notify (gdebenz merge) failed for region ${region.name}:`, err.message);
    }

    if (skipped > 0) {
      logger.warn(`Region "${region.name}" (gdebenz): skipped ${skipped} station(s) with unrecognized shape`);
    }
    logger.info(`Region "${region.name}" (gdebenz): stored ${stored} station(s)`);
    return { stationCount: stored, skipped };
  } catch (err) {
    region.lastGdebenzPolledAt = polledAt;
    region.lastGdebenzPollStatus = 'error';
    region.lastGdebenzPollError = err.message;
    await region.save();
    logger.error(`Region "${region.name}": gdebenz poll failed:`, err.message);
    throw err;
  }
}

module.exports = { ingestGdebenzRegion, applyMergeToStation };
