const Station = require('../models/Station');
const StationSnapshot = require('../models/StationSnapshot');
const { mergeStationFuelStatuses, mergeStationOverallStatus } = require('./mergeStatusService');
const { getSource } = require('./sourceRegistry');
const telegramNotifier = require('./telegramNotifier');
const { recordPollAttempt } = require('./pollLogService');
const { capRawResponse } = require('../utils/rawResponseCap');
const logger = require('../utils/logger');

// Dual-write helper for Region.sourcePollStatus (see the field's doc comment
// on the model) - upserts this source's entry in place rather than pushing a
// duplicate every poll tick. requestUrl/rawResponse are optional: the error
// path below always has a URL (built independently of the failed request)
// but never a response, and omitting rawResponse there (rather than passing
// null) leaves whatever real response is already stored from this source's
// last success in place instead of wiping it.
function setSourcePollStatus(region, sourceKey, { lastPolledAt, status, error, stationCount, requestUrl, rawResponse }) {
  const patch = { lastPolledAt, status, error, stationCount };
  if (requestUrl !== undefined) patch.requestUrl = requestUrl;
  if (rawResponse !== undefined) patch.rawResponse = rawResponse;

  const entry = region.sourcePollStatus.find((s) => s.sourceKey === sourceKey);
  if (entry) {
    Object.assign(entry, patch);
  } else {
    region.sourcePollStatus.push({ sourceKey, ...patch });
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
 * Reads every currently-linked secondary source's latest stored reading (via
 * Station.sourceLinks) and folds it with tbank's own last reading into one
 * merged {status, fuelStatuses} pair - not just the one source that happened
 * to poll and trigger the recompute. With exactly one linked secondary
 * source (gdebenz, today) this reads identically to the old two-source
 * merge; once a second secondary source can be linked to the same station,
 * this is what makes both of them count. Pure read, no writes - shared by
 * both applyMergeToStation (single fresh snapshot) and applyMergeToStationForTick
 * (overwrites the current poll tick's snapshot) below.
 */
async function computeMergedStatusForStation(station) {
  const secondaryReadings = [];
  for (const link of station.sourceLinks || []) {
    const sourceConfig = getSource(link.sourceKey);
    if (!sourceConfig) continue; // an unregistered/removed source's stale link - ignore, don't crash the merge
    const doc = await sourceConfig.model.findById(link.refId).lean();
    if (!doc) continue;
    secondaryReadings.push({ status: doc.status, fuelTypes: doc.fuelTypes, weight: sourceConfig.weight });
  }

  return {
    mergedFuelStatuses: mergeStationFuelStatuses(station.tbankLastFuelStatuses, secondaryReadings),
    mergedStatus: mergeStationOverallStatus(station.tbankLastStatus, secondaryReadings),
  };
}

/**
 * Recomputes and writes the merged status for a Station, then appends a
 * brand-new StationSnapshot for it. Writes to the exact same fields the
 * tbank poll itself does (see ingestService.storeStation) - so from every
 * other consumer's point of view (metrics, reports, forecasts, Telegram)
 * this looks like an ordinary poll, not a second/third data source.
 *
 * Only for one-off, out-of-band recomputes that aren't standing in for a
 * poll tick's own snapshot - today, that's stationMatching.controller.js's
 * confirmMatch applying a brand-new match immediately instead of waiting for
 * the next poll. The region poll loop itself uses applyMergeToStationForTick
 * below instead, specifically to avoid inserting a second snapshot on top of
 * the one ingestService.storeStation already wrote this same tick (see that
 * function's doc comment for why: an extra row per linked secondary source
 * per tick silently double/triple-counted matched stations in every
 * snapshot-driven aggregate - metrics percentages, outage streaks, hourly
 * forecast profiles).
 */
async function applyMergeToStation(station, region, polledAt) {
  const previousFuelStatuses = station.lastFuelStatuses;
  const { mergedFuelStatuses, mergedStatus } = await computeMergedStatusForStation(station);

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
 * Same recompute as applyMergeToStation, but for the region poll loop: all
 * secondary sources for a region are ingested against the same tbank poll
 * tick (see ingestService.ingestRegion), and ingestService.storeStation
 * already created this tick's StationSnapshot for every station, tagged with
 * the tick's own `polledAt`. Overwrites that exact row (matched on
 * {station, polledAt}) instead of inserting a new one, so a station matched
 * to N secondary sources still ends up with exactly one snapshot for this
 * tick - carrying the final merged status once every source has been read -
 * rather than N+1.
 */
// No transition/notify computation here on purpose (unlike applyMergeToStation
// above) - see remergeStationsForTick's doc comment for why the region poll
// loop computes transitions once per tick, after this write, instead of
// per-write here.
async function applyMergeToStationForTick(station, region, polledAt) {
  const { mergedFuelStatuses, mergedStatus } = await computeMergedStatusForStation(station);

  station.lastStatus = mergedStatus;
  station.lastFuelStatuses = mergedFuelStatuses;
  station.lastSeenAt = polledAt;
  await station.save();

  await StationSnapshot.findOneAndUpdate(
    { station: station._id, polledAt },
    {
      $set: {
        region: region._id,
        lat: station.lat,
        lon: station.lon,
        status: mergedStatus,
        fuelStatuses: mergedFuelStatuses,
        lastTransactionAt: station.lastTransactionAt,
        raw: { mergedFromSourceLinks: station.sourceLinks },
      },
    },
    { upsert: true }
  );
}

/**
 * Batch entry point for the region poll loop: dedupes station ids touched by
 * any secondary source this tick (a station matched to two sources appears
 * once per source's own ingest pass) and remerges each exactly once, after
 * every source's own storeSecondaryStation write for this tick has already
 * landed - so a station matched to both gdebenz and sberazs picks up both
 * sources' latest readings in its one merge, instead of merging twice with
 * whichever source happened to be read first missing the other's update.
 *
 * Deliberately doesn't compute/return transitions itself (unlike the old
 * per-source applyMergeToStation call this replaced) - ingestService.ingestRegion
 * does that once per tick, comparing each touched station's status from
 * *before this entire tick's writes* against its final status *after* both
 * the tbank write and this remerge. Comparing in two hops instead (previous
 * vs tbank-raw, then tbank-raw vs merged - what this function's writes would
 * otherwise be compared against on their own) silently drops real
 * available -> not_available transitions whenever tbank's own raw reading is
 * 'no_data' in between (common for a station whose live signal now comes
 * from a secondary source rather than tbank itself): 'no_data' isn't
 * 'available' so the first hop doesn't count as a drop, and it isn't
 * 'not_available' either so computeTransitions' strict
 * previous==='available' requirement for a "пропало" event never sees the
 * true previous 'available' state on the hop that actually lands on
 * 'not_available'. A single previous-tick-final vs this-tick-final
 * comparison doesn't have that blind spot.
 */
async function remergeStationsForTick(stationIds, region, polledAt) {
  const uniqueIds = [...new Set(stationIds.map(String))];
  for (const id of uniqueIds) {
    const station = await Station.findById(id);
    if (!station) continue; // matched station deleted since this source's poll ran
    await applyMergeToStationForTick(station, region, polledAt);
  }
  return uniqueIds;
}

/**
 * Fetches stations for a region's bounding box (same bbox as tbank) from one
 * registered secondary source and upserts each into that source's own
 * collection. Returns the matchedStationId of every admin-confirmed match
 * touched this call, for the caller to remerge - doesn't merge/notify itself
 * (see remergeStationsForTick above), so that a station matched to several
 * sources gets exactly one remerge/notification per poll tick, folding in
 * every source's just-stored reading at once, instead of one remerge per
 * source that happened to touch it. Mirrors ingestService.ingestRegion's own
 * shape (per-region poll-status bookkeeping) so a problem with any one
 * source is visible the same way a tbank one would be, without ever being
 * able to break tbank ingestion itself - see the try/catch around each call
 * to this function in ingestService.ingestRegion.
 */
async function ingestSecondarySourceRegion(sourceConfig, region) {
  const polledAt = new Date();
  const bbox = { minLat: region.minLat, maxLat: region.maxLat, minLon: region.minLon, maxLon: region.maxLon };
  try {
    const { data: payload, requestUrl } = await sourceConfig.fetchStations(bbox);
    const rawStations = sourceConfig.extractStationsArray(payload);

    let stored = 0;
    let skipped = 0;
    const matchedStationIds = [];
    for (const raw of rawStations) {
      const parsed = sourceConfig.parseStation(raw);
      if (!parsed) {
        skipped += 1;
        continue;
      }
      try {
        const secondaryDoc = await storeSecondaryStation(sourceConfig, parsed, region, polledAt);
        stored += 1;
        if (secondaryDoc.matchedStationId) matchedStationIds.push(secondaryDoc.matchedStationId);
      } catch (err) {
        logger.error(`Failed to store ${sourceConfig.key} station for region ${region.name}:`, err.message);
      }
    }

    setSourcePollStatus(region, sourceConfig.key, {
      lastPolledAt: polledAt,
      status: 'ok',
      error: null,
      stationCount: stored,
      requestUrl,
      rawResponse: capRawResponse(payload),
    });
    await region.save();
    await recordPollAttempt({ region, sourceKey: sourceConfig.key, status: 'ok', error: null, stationCount: stored });

    if (skipped > 0) {
      logger.warn(`Region "${region.name}" (${sourceConfig.key}): skipped ${skipped} station(s) with unrecognized shape`);
    }
    logger.info(`Region "${region.name}" (${sourceConfig.key}): stored ${stored} station(s)`);
    return { stationCount: stored, skipped, matchedStationIds };
  } catch (err) {
    // Same reasoning as tbankClient's own catch path: the request may never
    // have gone out, but the URL is still worth showing/copying, and
    // rawResponse is deliberately omitted (not set to null) so a stale-but-
    // real previous response stays in place instead of being wiped.
    let requestUrl;
    try {
      requestUrl = sourceConfig.buildRequestUrl(bbox);
    } catch {
      // Must never shadow the real ingest error below.
    }
    setSourcePollStatus(region, sourceConfig.key, {
      lastPolledAt: polledAt,
      status: 'error',
      error: err.message,
      stationCount: 0,
      requestUrl,
    });
    await region.save();
    await recordPollAttempt({ region, sourceKey: sourceConfig.key, status: 'error', error: err.message, stationCount: 0 });
    logger.error(`Region "${region.name}": ${sourceConfig.key} poll failed:`, err.message);
    throw err;
  }
}

module.exports = { ingestSecondarySourceRegion, applyMergeToStation, remergeStationsForTick };
