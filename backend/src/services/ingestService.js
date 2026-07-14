const tbankClient = require('./tbankClient');
const { fetchStations } = tbankClient;
const { extractStationsArray, parseStation } = require('./stationParser');
const Station = require('../models/Station');
const StationSnapshot = require('../models/StationSnapshot');
const telegramNotifier = require('./telegramNotifier');
const { ingestSecondarySourceRegion, remergeStationsForTick } = require('./secondarySourceIngestService');
const { listSources } = require('./sourceRegistry');
const { recordPollAttempt } = require('./pollLogService');
const { capRawResponse } = require('../utils/rawResponseCap');
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
  // Also carries nameEditedByAdmin/addressEditedByAdmin, so an admin
  // correction (see stations.controller.js's updateStationDetails) isn't
  // silently reverted by this same write a few lines down.
  const previous = await Station.findOne(
    dedupeFilter,
    { lastFuelStatuses: 1, confirmedFuelStatuses: 1, nameEditedByAdmin: 1, addressEditedByAdmin: 1 }
  ).lean();

  const setFields = {
    externalId: parsed.externalId,
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
  };
  if (!previous?.nameEditedByAdmin) setFields.name = parsed.name;
  if (!previous?.addressEditedByAdmin) setFields.address = parsed.address;

  const station = await Station.findOneAndUpdate(
    dedupeFilter,
    {
      $set: setFields,
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

  // The transition notification isn't computed here - see ingestRegion's own
  // comment on why it's deferred until every write for this tick (this
  // tbank write, then any secondary-source remerge) has landed, using this
  // `previousFuelStatuses`/`previousConfirmedFuelStatuses` as the one true
  // "before" values.
  return {
    station,
    previousFuelStatuses: previous?.lastFuelStatuses || [],
    previousConfirmedFuelStatuses: previous?.confirmedFuelStatuses || [],
  };
}

/**
 * Fetches current stations for a region's bounding box and appends a new
 * historical snapshot per station. Always updates the region's poll status,
 * even on failure, so the admin UI can surface it.
 */
async function ingestRegion(region) {
  const polledAt = new Date();
  const bbox = { minLat: region.minLat, maxLat: region.maxLat, minLon: region.minLon, maxLon: region.maxLon };
  try {
    const { data: payload, requestUrl } = await fetchStations(bbox);
    const rawStations = extractStationsArray(payload);

    let stored = 0;
    let skipped = 0;
    // Each touched station's fuel statuses (raw and confirmed) from *before
    // any write this tick* - the one true "previous" a transition
    // notification should be compared against (see the comment on the
    // final notifyRegionChanges call below for why this has to be a single
    // before/after comparison spanning both the tbank write and any
    // secondary-source remerge, rather than one comparison per write).
    const previousByStationId = new Map();
    const previousConfirmedByStationId = new Map();
    for (const raw of rawStations) {
      const parsed = parseStation(raw);
      if (!parsed) {
        skipped += 1;
        continue;
      }
      try {
        const { station, previousFuelStatuses, previousConfirmedFuelStatuses } = await storeStation(
          parsed,
          region,
          polledAt
        );
        previousByStationId.set(String(station._id), previousFuelStatuses);
        previousConfirmedByStationId.set(String(station._id), previousConfirmedFuelStatuses);
        stored += 1;
      } catch (err) {
        logger.error(`Failed to store station for region ${region.name}:`, err.message);
      }
    }

    region.lastPolledAt = polledAt;
    region.lastPollStatus = 'ok';
    region.lastPollError = null;
    region.lastPollStationCount = stored;
    region.lastRequestUrl = requestUrl;
    region.lastRawResponse = capRawResponse(payload);
    await region.save();
    await recordPollAttempt({ region, sourceKey: 'tbank', status: 'ok', error: null, stationCount: stored });

    // Best-effort, same reasoning as the Telegram notify below: a secondary
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

    // A station matched to a secondary source but not itself present in
    // tbank's response this tick (previousByStationId has no entry for it
    // yet) still needs its true "before" values captured, from right before
    // the remerge below is its only write this tick.
    const uniqueMatchedIds = [...new Set(matchedStationIds.map(String))];
    for (const id of uniqueMatchedIds) {
      if (!previousByStationId.has(id)) {
        const existing = await Station.findById(id, { lastFuelStatuses: 1, confirmedFuelStatuses: 1 }).lean();
        previousByStationId.set(id, existing?.lastFuelStatuses || []);
        previousConfirmedByStationId.set(id, existing?.confirmedFuelStatuses || []);
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
        await remergeStationsForTick(matchedStationIds, region, polledAt);
      } catch (err) {
        logger.error(`Secondary-source merge failed for region ${region.name}:`, err.message);
      }
    }

    // Transitions computed once per touched station, comparing its status
    // from before ANY write this tick to its final status after both the
    // tbank write and (if matched) the remerge - and sent as one batch per
    // chat, instead of notifying the moment each station is stored, since a
    // poll that changes several stations shouldn't turn into a burst of
    // near-simultaneous messages. Comparing before/after in two separate
    // hops instead (previous vs tbank-raw, then tbank-raw vs merged) used to
    // silently drop real available -> not_available transitions whenever
    // tbank's own raw reading was 'no_data' in between (common once a
    // station's live signal comes from a secondary source rather than
    // tbank itself): 'no_data' is neither 'available' nor 'not_available',
    // so neither hop's strict comparison ever saw the true
    // available -> not_available pair - "появилось" alerts kept firing
    // (that event only needs "wasn't available before, is now") while
    // "пропало" alerts (which need the *exact* prior state to be
    // 'available') silently stopped.
    //
    // computeTransitions also compares against confirmedFuelStatuses (see
    // its own doc comment and Station.js's), not just the raw previous
    // poll - so this loop persists the returned nextConfirmedFuelStatuses
    // back onto the station right away, keeping that memory current for
    // next tick regardless of whether this tick produced an actual
    // transition worth alerting on.
    const touchedIds = [...new Set([...previousByStationId.keys()])];
    const stationEvents = [];
    if (touchedIds.length) {
      const finalStations = await Station.find({ _id: { $in: touchedIds } });
      for (const station of finalStations) {
        const previousFuelStatuses = previousByStationId.get(String(station._id)) || [];
        const previousConfirmedFuelStatuses = previousConfirmedByStationId.get(String(station._id)) || [];
        const { transitions, nextConfirmedFuelStatuses } = telegramNotifier.computeTransitions(
          previousFuelStatuses,
          previousConfirmedFuelStatuses,
          station.lastFuelStatuses
        );
        station.confirmedFuelStatuses = nextConfirmedFuelStatuses;
        await station.save();
        if (transitions.length) stationEvents.push({ station, transitions });
      }
    }

    // Best-effort: a Telegram hiccup must never break ingestion.
    try {
      await telegramNotifier.notifyRegionChanges(region, stationEvents);
    } catch (err) {
      logger.error(`Telegram notify failed for region ${region.name}:`, err.message);
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
    // The request itself may never have gone out (or gone out and failed) -
    // still worth showing/copying, so an admin can try it by hand. Doesn't
    // touch lastRawResponse: a stale-but-real previous response is more
    // useful to keep around than wiping it because this attempt had none.
    try {
      region.lastRequestUrl = tbankClient.buildRequestUrl(bbox);
    } catch {
      // Building the URL itself shouldn't ever throw, but this must never
      // shadow the real ingest error below if it somehow does.
    }
    await region.save();
    await recordPollAttempt({ region, sourceKey: 'tbank', status: 'error', error: err.message, stationCount: 0 });
    logger.error(`Region "${region.name}": poll failed:`, err.message);
    throw err;
  }
}

module.exports = { ingestRegion };
