const { fetchStations } = require('./tbankClient');
const { extractStationsArray, parseStation } = require('./stationParser');
const Station = require('../models/Station');
const StationSnapshot = require('../models/StationSnapshot');
const telegramNotifier = require('./telegramNotifier');
const { ingestSecondarySourceRegion, remergeStationsForTick } = require('./secondarySourceIngestService');
const { listSources } = require('./sourceRegistry');
const logger = require('../utils/logger');

async function storeStation(parsed, region, polledAt) {
  // yandexOrgId identifies the physical business location and is stable
  // across tbank's own externalId churn (see the doc comment on the Station
  // model) - prefer it whenever tbank reports one, and only fall back to
  // externalId for the rare station where it's missing.
  const dedupeFilter = parsed.yandexOrgId
    ? { yandexOrgId: parsed.yandexOrgId }
    : { externalId: parsed.externalId };

  // Needed before the update to detect available/unavailable transitions per
  // fuel type - findOneAndUpdate with new:true only gives us the post-update
  // document, which would make every poll look like a "first time seen".
  const previous = await Station.findOne(
    dedupeFilter,
    { lastFuelStatuses: 1 }
  ).lean();

  const station = await Station.findOneAndUpdate(
    dedupeFilter,
    {
      $set: {
        externalId: parsed.externalId,
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
        // again right after by secondarySourceIngestService's merge, later
        // in this same ingest tick, if this station has any confirmed
        // secondary-source match (see sourceRegistry.js).
        tbankLastStatus: parsed.status,
        tbankLastFuelStatuses: parsed.fuelStatuses,
        tbankLastSeenAt: polledAt,
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

    // Best-effort, same reasoning as the Telegram notify above: a secondary
    // source (see sourceRegistry.js) being down/slow/changed-shape must
    // never break the primary tbank ingestion this function exists for.
    // Runs on the same schedule as the tbank poll above (same region, same
    // tick) rather than its own separate timer - see
    // secondarySourceIngestService.js.
    const matchedStationIds = [];
    for (const source of listSources()) {
      try {
        const result = await ingestSecondarySourceRegion(source, region);
        matchedStationIds.push(...result.matchedStationIds);
      } catch (err) {
        logger.error(`${source.key} ingest failed for region ${region.name}:`, err.message);
      }
    }

    // One remerge per station touched by any source this tick (not one per
    // source) - reuses this tick's own `polledAt` so it overwrites the
    // StationSnapshot storeStation already wrote above instead of appending
    // a duplicate. See remergeStationsForTick's doc comment for why: a
    // second/third snapshot row per tick for matched stations was silently
    // inflating their weight in every snapshot-driven aggregate (metrics
    // percentages, outage streaks, hourly forecast profiles).
    if (matchedStationIds.length) {
      try {
        const mergeEvents = await remergeStationsForTick(matchedStationIds, region, polledAt);
        await telegramNotifier.notifyRegionChanges(region, mergeEvents);
      } catch (err) {
        logger.error(`Secondary-source merge failed for region ${region.name}:`, err.message);
      }
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
