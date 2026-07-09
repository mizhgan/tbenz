const Station = require('../models/Station');
const StationSnapshot = require('../models/StationSnapshot');
const { mergeStationFuelStatuses, mergeStationOverallStatus } = require('./mergeStatusService');
const { getSource } = require('./sourceRegistry');
const telegramNotifier = require('./telegramNotifier');
const logger = require('../utils/logger');

// Dual-write helper for Region.sourcePollStatus (see the field's doc comment
// on the model) - upserts this source's entry in place rather than pushing a
// duplicate every poll tick.
function setSourcePollStatus(region, sourceKey, { lastPolledAt, status, error, stationCount }) {
  const entry = region.sourcePollStatus.find((s) => s.sourceKey === sourceKey);
  if (entry) {
    entry.lastPolledAt = lastPolledAt;
    entry.status = status;
    entry.error = error;
    entry.stationCount = stationCount;
  } else {
    region.sourcePollStatus.push({ sourceKey, lastPolledAt, status, error, stationCount });
  }
}

async function storeSecondaryStation(sourceConfig, parsed, region, polledAt) {
  return sourceConfig.model.findOneAndUpdate(
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
 * Recomputes and writes the merged status for a Station, folding in every
 * currently-linked secondary source's latest stored reading (via
 * Station.sourceLinks) - not just the one that happened to poll and trigger
 * this recompute. With exactly one linked secondary source (gdebenz, today)
 * this reads identically to the old two-source applyMergeToStation; once a
 * second secondary source can be linked to the same station, this is what
 * makes both of them count. Writes to the exact same fields the tbank poll
 * itself does (see ingestService.storeStation) and appends a StationSnapshot
 * the same way - so from every other consumer's point of view (metrics,
 * reports, forecasts, Telegram) this looks like an ordinary poll, not a
 * second/third data source.
 */
async function applyMergeToStation(station, region, polledAt) {
  const previousFuelStatuses = station.lastFuelStatuses;

  const secondaryReadings = [];
  for (const link of station.sourceLinks || []) {
    const sourceConfig = getSource(link.sourceKey);
    if (!sourceConfig) continue; // an unregistered/removed source's stale link - ignore, don't crash the merge
    const doc = await sourceConfig.model.findById(link.refId).lean();
    if (!doc) continue;
    secondaryReadings.push({ status: doc.status, fuelTypes: doc.fuelTypes, weight: sourceConfig.weight });
  }

  const mergedFuelStatuses = mergeStationFuelStatuses(station.tbankLastFuelStatuses, secondaryReadings);
  const mergedStatus = mergeStationOverallStatus(station.tbankLastStatus, secondaryReadings);

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
    raw: { mergedFromSourceLinks: station.sourceLinks },
  });

  return telegramNotifier.computeTransitions(previousFuelStatuses, mergedFuelStatuses);
}

/**
 * Fetches stations for a region's bounding box (same bbox as tbank) from one
 * registered secondary source, upserts each into that source's own
 * collection, and for any that are already admin-confirmed matches to a
 * Station, folds the new reading into that Station via applyMergeToStation.
 * Mirrors ingestService.ingestRegion's own shape (per-region poll-status
 * bookkeeping, best-effort Telegram notify) so a problem with any one source
 * is visible the same way a tbank one would be, without ever being able to
 * break tbank ingestion itself - see the try/catch around each call to this
 * function in ingestService.ingestRegion.
 */
async function ingestSecondarySourceRegion(sourceConfig, region) {
  const polledAt = new Date();
  try {
    const payload = await sourceConfig.fetchStations({
      minLat: region.minLat,
      maxLat: region.maxLat,
      minLon: region.minLon,
      maxLon: region.maxLon,
    });
    const rawStations = sourceConfig.extractStationsArray(payload);

    let stored = 0;
    let skipped = 0;
    const stationEvents = [];
    for (const raw of rawStations) {
      const parsed = sourceConfig.parseStation(raw);
      if (!parsed) {
        skipped += 1;
        continue;
      }
      try {
        const secondaryDoc = await storeSecondaryStation(sourceConfig, parsed, region, polledAt);
        stored += 1;

        if (secondaryDoc.matchedStationId) {
          const station = await Station.findById(secondaryDoc.matchedStationId);
          if (station) {
            const transitions = await applyMergeToStation(station, region, polledAt);
            if (transitions.length) stationEvents.push({ station, transitions });
          }
        }
      } catch (err) {
        logger.error(`Failed to store ${sourceConfig.key} station for region ${region.name}:`, err.message);
      }
    }

    setSourcePollStatus(region, sourceConfig.key, { lastPolledAt: polledAt, status: 'ok', error: null, stationCount: stored });
    await region.save();

    try {
      await telegramNotifier.notifyRegionChanges(region, stationEvents);
    } catch (err) {
      logger.error(`Telegram notify (${sourceConfig.key} merge) failed for region ${region.name}:`, err.message);
    }

    if (skipped > 0) {
      logger.warn(`Region "${region.name}" (${sourceConfig.key}): skipped ${skipped} station(s) with unrecognized shape`);
    }
    logger.info(`Region "${region.name}" (${sourceConfig.key}): stored ${stored} station(s)`);
    return { stationCount: stored, skipped };
  } catch (err) {
    setSourcePollStatus(region, sourceConfig.key, { lastPolledAt: polledAt, status: 'error', error: err.message, stationCount: 0 });
    await region.save();
    logger.error(`Region "${region.name}": ${sourceConfig.key} poll failed:`, err.message);
    throw err;
  }
}

module.exports = { ingestSecondarySourceRegion, applyMergeToStation };
