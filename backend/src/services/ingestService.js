const { fetchStations } = require('./tbankClient');
const { extractStationsArray, parseStation } = require('./stationParser');
const Station = require('../models/Station');
const StationSnapshot = require('../models/StationSnapshot');
const telegramNotifier = require('./telegramNotifier');
const gdebenzIngestService = require('./gdebenzIngestService');
const logger = require('../utils/logger');

async function storeStation(parsed, region, polledAt) {
  // Needed before the update to detect available/unavailable transitions per
  // fuel type - findOneAndUpdate with new:true only gives us the post-update
  // document, which would make every poll look like a "first time seen".
  const previous = await Station.findOne(
    { externalId: parsed.externalId },
    { lastFuelStatuses: 1 }
  ).lean();

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
        // tbank's own reading, preserved separately - see the field's doc
        // comment on the Station model. This write always reflects tbank's
        // own poll; lastStatus/lastFuelStatuses above may get overwritten
        // again right after by gdebenzIngestService's merge, later in this
        // same ingest tick, if this station has a confirmed gdebenz match.
        tbankLastStatus: parsed.status,
        tbankLastFuelStatuses: parsed.fuelStatuses,
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

  const transitions = telegramNotifier.computeTransitions(
    previous?.lastFuelStatuses || [],
    parsed.fuelStatuses
  );
  return { station, transitions };
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
    // Collected across the whole poll and sent as one batch per chat below,
    // instead of notifying the moment each station is stored - the source
    // reports every station's state at once, so a poll that changes several
    // stations shouldn't turn into a burst of near-simultaneous messages.
    const stationEvents = [];
    for (const raw of rawStations) {
      const parsed = parseStation(raw);
      if (!parsed) {
        skipped += 1;
        continue;
      }
      try {
        const { station, transitions } = await storeStation(parsed, region, polledAt);
        if (transitions.length) stationEvents.push({ station, transitions });
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

    // Best-effort: a Telegram hiccup must never break ingestion.
    try {
      await telegramNotifier.notifyRegionChanges(region, stationEvents);
    } catch (err) {
      logger.error(`Telegram notify failed for region ${region.name}:`, err.message);
    }

    // Best-effort, same reasoning as the Telegram notify above: gdebenz
    // being down/slow/changed-shape must never break the primary tbank
    // ingestion this function exists for. Runs on the same schedule as the
    // tbank poll above (same region, same tick) rather than its own
    // separate timer - see gdebenzIngestService.js.
    try {
      await gdebenzIngestService.ingestGdebenzRegion(region);
    } catch (err) {
      logger.error(`gdebenz ingest failed for region ${region.name}:`, err.message);
    }

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
