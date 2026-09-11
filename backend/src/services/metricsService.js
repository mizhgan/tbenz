const StationSnapshot = require('../models/StationSnapshot');
const StationOutage = require('../models/StationOutage');
const Station = require('../models/Station');
const { listSources } = require('./sourceRegistry');
const { memoizeAsync } = require('../utils/cache');

const DEFAULT_TZ = 'Europe/Moscow';

// Snapshots land every pollIntervalMinutes (10 by default), so recomputing
// these aggregations more than once every few minutes buys nothing but load.
// A short TTL plus in-flight dedup is enough to collapse both same-user
// re-renders and internal reuse (e.g. telegramDigestData.js's own
// back-to-back getStationMetrics calls) into a single query where the exact
// same range/regionId repeats.
const METRICS_CACHE_TTL_MS = 5 * 60 * 1000;

function rangeKey(regionId, { from, to, bucketHours, tz } = {}) {
  return JSON.stringify([String(regionId), from?.toISOString(), to?.toISOString(), bucketHours, tz]);
}

function buildMatch(regionId, from, to) {
  const match = { region: regionId };
  if (from || to) {
    match.polledAt = {};
    if (from) match.polledAt.$gte = from;
    if (to) match.polledAt.$lte = to;
  }
  return match;
}

// "known" excludes no_data readings, since no_data means the source itself
// couldn't determine a status (not that fuel was confirmed absent) - mixing
// it into the denominator would unfairly punish stations with sparse
// transaction history.
//
// availablePct here is deliberately *strict* (available alone, not
// available+maybe_available) - this is the shared building block for both
// kinds of consumer this file has: stacked/multi-series ones
// (getAvailabilityTrend/getAvailabilitySeries feed TrendChart.vue and the
// Telegram digest sparkline, both of which explicitly add availablePct and
// maybeAvailablePct themselves to get a combined line - redefining
// availablePct here would silently double-count maybe_available in both),
// and single-headline-number ones (getStationMetrics/getSingleStationMetrics/
// getHeatmap, where a station or cell needs exactly one "доступность"
// figure). Single-number call sites use scoreAvailability below instead,
// applied as an explicit override right where they build their return
// value, not baked in here where it would leak into the stacked consumers
// too.
function withKnownPct(row) {
  const known = row.total - row.noData;
  const pct = (count) => (known > 0 ? (count / known) * 100 : null);
  return {
    availablePct: pct(row.available),
    maybeAvailablePct: pct(row.maybeAvailable),
    notAvailablePct: pct(row.notAvailable),
    noDataPct: row.total > 0 ? (row.noData / row.total) * 100 : null,
  };
}

// How much a maybe_available reading counts toward availability, everywhere
// a single "доступность" score is computed (not the raw stacked-chart
// breakdown, see withKnownPct's own doc comment) - full credit (1.0) let a
// station that has *never once* been confirmed available (all its "known"
// time split between maybe_available and not_available) still score
// respectably; 0 credit is too harsh given maybe_available genuinely means
// "probably there". 0.7 was chosen after comparing real stations live (see
// this constant's git history for the worked examples).
const MAYBE_AVAILABLE_WEIGHT = 0.7;

// What fraction of an entity's (station's, or heatmap cell's) own "typical"
// sample size for the queried period counts as enough evidence to mostly
// trust its raw rate over the regional average - see scoreAvailability's
// own doc comment. Expressed as a *fraction* of the period's own average
// known-reading count (via shrinkageM below), not a fixed reading count -
// an early version hardcoded m=60 (calibrated for a 24h digest's ~180
// known readings per station), which was fine for daily/reports-page
// queries but silently gutted the *hourly* Telegram digest: an hour only
// gives each station ~6 known readings, so weight = 6/(6+60) = 9% - every
// station's own hourly behavior got drowned out by the regional average,
// and the "most available" ranking degenerated into everyone showing
// nearly the same number regardless of how that specific hour actually
// went (reported live: 5 different stations all reading 29-30%). 1/3
// reproduces the original m=60 behavior for a 24h period while scaling
// down correctly for shorter ones.
const AVAILABILITY_SHRINKAGE_FRACTION = 1 / 3;

// The "one number that matters" version of a status breakdown - every
// single-headline-number consumer (getStationMetrics/getSingleStationMetrics/
// getHeatmap's per-cell score, MapView.vue's live badge, the Telegram
// digest/alert images) should read as the same thing, unlike the raw
// stacked-chart breakdown (withKnownPct's own strict fields).
//
// Two corrections on top of the naive "(available+maybe)/known" percentage:
//
// 1. maybe_available gets partial (MAYBE_AVAILABLE_WEIGHT), not full,
//    credit - see that constant's own comment.
// 2. When `prior` is given, the raw rate is shrunk toward it in proportion
//    to how little evidence (`known` readings) actually backs it up - the
//    classic small-sample-leaderboard fix (same idea IMDb's own weighted
//    rating uses). Without this, a station with a week of no_data followed
//    by one hour of available scored 100% - all the way to the extreme -
//    off a single observation. `prior` should be the region's own overall
//    rate for the same period, and `m` should be shrinkageM's own output
//    for that same period/entity type - omitting `prior` returns the plain
//    unshrunk rate.
//
// IMPORTANT: this shrunk result is only ever safe to use for *ranking*
// (deciding which stations count as "top"/"bottom"), never for display -
// see getStationMetricsUncached's own rankScore field for why: a reader
// has no way to tell a shrunk figure apart from a literal one, and a
// station with a genuinely perfect period printing anything less than
// 100% reads as a bug, not a nuance.
function scoreAvailability(row, { prior = null, m = 0 } = {}) {
  const known = row.total - row.noData;
  if (known <= 0) return prior;
  const raw = ((row.available + MAYBE_AVAILABLE_WEIGHT * row.maybeAvailable) / known) * 100;
  if (prior === null) return raw;
  const weight = known / (known + m);
  return weight * raw + (1 - weight) * prior;
}

// See AVAILABILITY_SHRINKAGE_FRACTION's own doc comment - `avgKnownPerEntity`
// is that same period's own average known-reading count per station, so
// short queries automatically get a proportionally smaller, less-punishing
// m instead of one calibrated for a whole day.
function shrinkageM(avgKnownPerEntity) {
  return AVAILABILITY_SHRINKAGE_FRACTION * Math.max(0, avgKnownPerEntity);
}

// Gasoline only (92/95) - not diesel or gas conversions (propane/methane).
// Deliberate, explicit call: gasoline is where this region's real shortage
// is - verified live, 92 at ~25%, 95 at ~29.5%, pooled ~27.3%, against
// diesel's own ~38.7% over the same stations/period. Folding diesel into the
// "main" availability metric would have quietly diluted the number away
// from the fuel drivers are actually struggling to find, in the direction
// that makes things look better than they are. Same set MapView.vue's
// currentSummary pools client-side for the map badge (and now defaults its
// fuel-type filter to) - see that file's doc comment for the fuller history
// of why this reads differently from a snapshot's one blanket overall
// `status` at all.
const CORE_FUEL_TYPES = ['92', '95'];

const CORE_STATUS_RANK = { not_available: 0, no_data: 1, maybe_available: 2, available: 3 };

/**
 * Best-of among a station's (or one source's) own CORE_FUEL_TYPES readings -
 * "is at least one of the fuels a driver actually wants available right
 * now", same framing as MapView.vue's own effectiveStatus (best-of among
 * selected fuel types). Used wherever a single categorical status needs to
 * represent "this station/source, as far as the fuel types that matter" -
 * classifying a station up/down for predictive alerts
 * (telegramPredictiveAlerts.js), and deciding whether two sources actually
 * disagree for the map popup's "⚠ расходятся" warning (MapView.vue) instead
 * of comparing their blanket overall statuses, which could differ purely
 * over a non-core fuel type (diesel, propane, ...) neither claim says
 * anything useful about for this purpose.
 */
function deriveCoreStatus(fuelStatuses) {
  const relevant = (fuelStatuses || []).filter((f) => CORE_FUEL_TYPES.includes(f.fuelType));
  if (!relevant.length) return 'no_data';
  return relevant.reduce(
    (best, f) => (CORE_STATUS_RANK[f.status] > CORE_STATUS_RANK[best] ? f.status : best),
    relevant[0].status
  );
}

// Inserted right after a pipeline's own $match stage (see every use below):
// unwinds each snapshot into up to 2 rows, one per core fuel type (92/95) it
// has a reading for, so STATUS_COUNTS_GROUP counts each fuel-type reading as
// its own vote instead of one blanket per-snapshot vote. A snapshot with no
// reading for either (fuelStatuses empty, or only non-core types - diesel,
// propane, methane) contributes zero rows here rather than one "no_data"
// row - deliberately: see STATUS_COUNTS_GROUP's own total/noData, which
// would otherwise treat "this station only sells diesel" the same as "we
// don't know 92/95's status", diluting noDataPct for something that isn't
// actually missing data.
const CORE_FUEL_UNWIND_STAGES = [
  {
    $addFields: {
      coreFuelStatuses: {
        $filter: {
          input: { $ifNull: ['$fuelStatuses', []] },
          cond: { $in: ['$$this.fuelType', CORE_FUEL_TYPES] },
        },
      },
    },
  },
  { $unwind: '$coreFuelStatuses' },
];

const STATUS_COUNTS_GROUP = {
  total: { $sum: 1 },
  available: { $sum: { $cond: [{ $eq: ['$coreFuelStatuses.status', 'available'] }, 1, 0] } },
  maybeAvailable: { $sum: { $cond: [{ $eq: ['$coreFuelStatuses.status', 'maybe_available'] }, 1, 0] } },
  notAvailable: { $sum: { $cond: [{ $eq: ['$coreFuelStatuses.status', 'not_available'] }, 1, 0] } },
  noData: { $sum: { $cond: [{ $eq: ['$coreFuelStatuses.status', 'no_data'] }, 1, 0] } },
};

/**
 * The most recent snapshot at or before `at`, per station in the region -
 * "what does the region look like right now" rather than an aggregate over
 * a period. Shared by the region-snapshot endpoint (map's live/at-time view)
 * and the Telegram digest (current status breakdown).
 */
async function getCurrentSnapshotUncached(regionId, at) {
  const sources = listSources();

  const pipeline = [
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
  ];

  // Only each source's own status - enough for the map popup's one-line
  // "sources" summary. The full per-source breakdown (fuel types, address,
  // conflict) is fetched on demand by StationDetailModal via
  // GET /stations/:id, the same endpoint the admin station-sources view
  // uses, rather than carried by every station in every snapshot here.
  // One $lookup per registered secondary source (see sourceRegistry.js),
  // matched via Station.sourceLinks - generalizes what used to be a single
  // hardcoded gdebenzstations lookup keyed off Station.gdebenzStationId.
  const infoFields = [];
  for (const source of sources) {
    const infoField = `info_${source.key}`;
    infoFields.push({ key: source.key, field: infoField });
    pipeline.push({
      $lookup: {
        from: source.model.collection.name,
        let: {
          linkId: {
            $let: {
              vars: {
                matches: {
                  $filter: {
                    input: { $ifNull: ['$stationInfo.sourceLinks', []] },
                    cond: { $eq: ['$$this.sourceKey', source.key] },
                  },
                },
              },
              in: { $arrayElemAt: ['$$matches.refId', 0] },
            },
          },
        },
        pipeline: [{ $match: { $expr: { $eq: ['$_id', '$$linkId'] } } }],
        as: infoField,
      },
    });
    pipeline.push({ $unwind: { path: `$${infoField}`, preserveNullAndEmptyArrays: true } });
  }

  pipeline.push({
    $project: {
      _id: 0,
      stationId: '$station',
      polledAt: 1,
      lat: 1,
      lon: 1,
      status: 1,
      fuelStatuses: 1,
      lastTransactionAt: 1,
      // The freshest genuine transaction time across tbank *and* every
      // matched secondary source - see Station.js's own doc comment. What
      // MapView.vue's popup and StationDetailModal.vue's top line actually
      // show as "Последняя транзакция" now, instead of tbank's own
      // lastTransactionAt right above (kept, unchanged, for the sources
      // table's own "tbank" column/tile, which specifically wants tbank's
      // own reading).
      overallLastTransactionAt: 1,
      name: '$stationInfo.name',
      address: '$stationInfo.address',
      yandexOrgId: '$stationInfo.yandexOrgId',
      tbankStatus: {
        $ifNull: [
          '$stationInfo.tbankLastStatus',
          {
            $cond: [
              { $gt: [{ $size: { $ifNull: ['$stationInfo.sourceLinks', []] } }, 0] },
              'no_data',
              '$status',
            ],
          },
        ],
      },
      // Raw fuelStatuses per source (and tbank's own, below) - collapsed
      // into a single coreStatus field and dropped again right after the
      // aggregation returns (see the post-processing loop below), so the
      // response actually sent to the browser doesn't grow, just gains one
      // extra short string per source. Needed so the map popup's "⚠
      // расходятся" warning can compare sources' CORE_FUEL_TYPES agreement
      // instead of their blanket overall status (see deriveCoreStatus's doc
      // comment) - a status this bare, hottest-endpoint response otherwise
      // deliberately never carries at all.
      tbankFuelStatuses: { $ifNull: ['$stationInfo.tbankLastFuelStatuses', []] },
      // Only sources this station is actually matched to (a registered but
      // unmatched source contributes no entry, not a null-status one).
      sources: {
        $filter: {
          input: infoFields.map(({ key, field }) => ({
            key,
            status: { $ifNull: [`$${field}.status`, null] },
            fuelStatuses: { $ifNull: [`$${field}.fuelStatuses`, []] },
          })),
          cond: { $ne: ['$$this.status', null] },
        },
      },
    },
  });

  const rows = await StationSnapshot.aggregate(pipeline);
  for (const row of rows) {
    row.tbankCoreStatus = deriveCoreStatus(row.tbankFuelStatuses);
    delete row.tbankFuelStatuses;
    for (const source of row.sources) {
      source.coreStatus = deriveCoreStatus(source.fuelStatuses);
      delete source.fuelStatuses;
    }
  }
  return rows;
}

// This is the single hottest public endpoint (the map's live view polls it
// repeatedly, see MapView.vue/regions.controller.js's getRegionSnapshot) -
// unlike the other memoized functions below, callers vary in how precise
// their own `at` needs to be: the map's live-mode controller rounds `at` to
// a 60s boundary before calling this (so concurrent/repeated live polls
// share one cached aggregation), while the Telegram digest and the map's
// historical time-slider pass an exact timestamp on purpose and get their
// own cache entry each - this function itself doesn't need to know which
// case it's in, it just caches whatever key it's given.
const getCurrentSnapshot = memoizeAsync(getCurrentSnapshotUncached, {
  ttlMs: 60 * 1000,
  keyFn: (regionId, at) => `${String(regionId)}:${at.getTime()}`,
});

/**
 * Region-wide availability trend, bucketed into fixed-size time windows.
 */
async function getAvailabilityTrendUncached(regionId, { from, to, bucketHours = 24, tz = DEFAULT_TZ }) {
  const match = buildMatch(regionId, from, to);
  const unit = bucketHours >= 24 && bucketHours % 24 === 0 ? 'day' : 'hour';
  const binSize = unit === 'day' ? bucketHours / 24 : bucketHours;

  // Clamped to where this region actually has snapshot history within the
  // requested window - see getSnapshotDataBounds' own doc comment for why
  // (and why this can't just use this function's own $group rows for that -
  // getRecoveryTrend needs the exact same clamp from the exact same source
  // to keep both charts' bucket counts equal, and it has no StationSnapshot
  // rows of its own to derive one from).
  const bounds = await getSnapshotDataBounds(match);
  if (!bounds) return [];

  const rows = await StationSnapshot.aggregate([
    { $match: match },
    ...CORE_FUEL_UNWIND_STAGES,
    {
      $group: {
        _id: {
          $dateTrunc: { date: '$polledAt', unit, binSize, timezone: tz },
        },
        ...STATUS_COUNTS_GROUP,
      },
    },
    { $sort: { _id: 1 } },
  ]);
  const rowByBucketStartMs = new Map(rows.map((row) => [row._id.getTime(), row]));

  // Fills every expected boundary, not just ones $group actually returned -
  // see enumerateBucketStarts' own doc comment for why (keeps this chart's
  // bucket count in sync with getRecoveryTrend's own).
  return enumerateBucketStarts(bounds.min, new Date(bounds.max.getTime() + 1), unit, binSize).map((bucketStart) => {
    const row = rowByBucketStartMs.get(bucketStart.getTime());
    const counts = row || { total: 0, available: 0, maybeAvailable: 0, notAvailable: 0, noData: 0 };
    return {
      bucketStart,
      total: counts.total,
      available: counts.available,
      maybeAvailable: counts.maybeAvailable,
      notAvailable: counts.notAvailable,
      noData: counts.noData,
      ...withKnownPct(counts),
    };
  });
}

const getAvailabilityTrend = memoizeAsync(getAvailabilityTrendUncached, {
  ttlMs: METRICS_CACHE_TTL_MS,
  keyFn: (regionId, opts) => rangeKey(regionId, opts),
});

/**
 * Same bucketed-availability computation as getAvailabilityTrend, scoped to
 * one station instead of a whole region - added for forecastService.js's
 * per-station short-term trend extrapolation (see that file's own doc
 * comment on why a single station's recent trajectory replaced the old
 * weekday/hour seasonal profile there). Kept here rather than in
 * forecastService.js since it's the exact same CORE_FUEL_UNWIND_STAGES/
 * STATUS_COUNTS_GROUP/withKnownPct pipeline as getAvailabilityTrend, just a
 * different $match.
 */
async function getStationTrendUncached(stationId, { from, to, bucketHours = 1, tz = DEFAULT_TZ }) {
  const unit = bucketHours >= 24 && bucketHours % 24 === 0 ? 'day' : 'hour';
  const binSize = unit === 'day' ? bucketHours / 24 : bucketHours;

  const rows = await StationSnapshot.aggregate([
    { $match: { station: stationId, polledAt: { $gte: from, $lte: to } } },
    ...CORE_FUEL_UNWIND_STAGES,
    {
      $group: {
        _id: { $dateTrunc: { date: '$polledAt', unit, binSize, timezone: tz } },
        ...STATUS_COUNTS_GROUP,
      },
    },
    { $sort: { _id: 1 } },
  ]);

  return rows.map((row) => ({
    bucketStart: row._id,
    total: row.total,
    ...withKnownPct(row),
  }));
}

const getStationTrend = memoizeAsync(getStationTrendUncached, {
  ttlMs: METRICS_CACHE_TTL_MS,
  keyFn: (stationId, opts) => rangeKey(stationId, opts),
});

/**
 * Availability series bucketed into roughly `bucketCount` evenly-spaced
 * minute-granularity windows - used for the Telegram digest sparkline,
 * which needs finer/more flexible buckets than getAvailabilityTrend's
 * hour/day-only granularity (e.g. an hourly digest's 1-hour window has to
 * be sliced into a handful of few-minute buckets, not whole hours).
 *
 * Unlike getAvailabilityTrend, this fills every expected bucket boundary
 * explicitly (including ones with zero snapshots) so a sparkline drawn from
 * the result has evenly-spaced points on the time axis instead of silently
 * skipping gaps - $group only ever returns buckets that had data.
 */
async function getAvailabilitySeries(regionId, { from, to, bucketCount = 12 }) {
  const spanMs = to.getTime() - from.getTime();
  const binSizeMinutes = Math.max(1, Math.round(spanMs / bucketCount / 60000));
  const binSizeMs = binSizeMinutes * 60000;
  const match = buildMatch(regionId, from, to);

  const rows = await StationSnapshot.aggregate([
    { $match: match },
    ...CORE_FUEL_UNWIND_STAGES,
    {
      $group: {
        _id: { $dateTrunc: { date: '$polledAt', unit: 'minute', binSize: binSizeMinutes } },
        ...STATUS_COUNTS_GROUP,
      },
    },
    { $sort: { _id: 1 } },
  ]);
  const rowByBucketStartMs = new Map(rows.map((row) => [row._id.getTime(), row]));

  const buckets = [];
  const firstBucketStartMs = Math.floor(from.getTime() / binSizeMs) * binSizeMs;
  for (let t = firstBucketStartMs; t < to.getTime(); t += binSizeMs) {
    const row = rowByBucketStartMs.get(t);
    buckets.push({
      bucketStart: new Date(t),
      total: row?.total ?? 0,
      ...(row
        ? withKnownPct(row)
        : { availablePct: null, maybeAvailablePct: null, notAvailablePct: null, noDataPct: null }),
    });
  }
  return buckets;
}

const RECOVERY_STATUSES = new Set(['available', 'maybe_available']);

// Walks one station's status history in order and measures how long it
// spent continuously in "not_available" before flipping back to an
// available/maybe_available reading. A trailing outage that never recovers
// within the queried window is intentionally excluded (its true duration is
// unknown - "censored" data).
//
// `outages` (each `{start, end, durationMinutes}`, in chronological order)
// is the individual record behind the outageCount/avgOutageMinutes
// aggregate - added for the recovery-time trend chart (getRecoveryTrend
// below) and the station card's recent-outages list (forecastService.js's
// getStationForecast), both of which need each outage on its own rather
// than just the average. Purely additive - every existing caller that only
// destructures {outageCount, avgOutageMinutes} is unaffected.
//
// `openStartedAt` surfaces that excluded trailing streak's own start (or
// null) - unused by any of the aggregate-number callers above, but lets
// scripts/backfillStationOutages.js seed Station.openOutages for a still-down
// station from the exact same scan, instead of a separate walk.
function computeOutages(history) {
  let outageCount = 0;
  let totalOutageMs = 0;
  let outageStartedAt = null;
  const outages = [];

  for (const snap of history) {
    if (snap.status === 'not_available') {
      if (outageStartedAt === null) outageStartedAt = snap.polledAt;
    } else if (outageStartedAt !== null && RECOVERY_STATUSES.has(snap.status)) {
      const durationMs = snap.polledAt.getTime() - outageStartedAt.getTime();
      totalOutageMs += durationMs;
      outageCount += 1;
      outages.push({ start: outageStartedAt, end: snap.polledAt, durationMinutes: durationMs / 60000 });
      outageStartedAt = null;
    }
    // status === 'no_data' while an outage is open: ambiguous, keep waiting.
  }

  return {
    outageCount,
    avgOutageMinutes: outageCount > 0 ? totalOutageMs / outageCount / 60000 : null,
    outages,
    openStartedAt: outageStartedAt,
  };
}

// The incremental twin of computeOutages above - advances one station's
// per-region streak state ("openOutages", see Station.js's own doc comment)
// by exactly one new snapshot instead of re-deriving the whole streak from a
// full raw-history scan. Pure/no I/O by design (same reasoning as
// computeOutages/telegramNotifier.computeTransitions being pure) so it can
// be unit-tested with plain objects the same way computeOutages already is,
// rather than needing a real Mongoose document or a database - the actual
// persistence (mutating Station.openOutages, writing a closed StationOutage
// row) is the caller's job, see ingestService.js's advanceOutageState.
//
// `openOutages` is `[{region, startedAt}]` (region compared via String() so
// this works with either a real ObjectId or a plain string/test id).
// Returns the next `openOutages` array and, if this snapshot closed a
// streak, the row to persist as `closedOutage` (`{region, start, end,
// durationMinutes}`) - `null` when nothing closed this tick.
function advanceOutageStreak(openOutages, regionId, status, polledAt) {
  const idx = openOutages.findIndex((entry) => String(entry.region) === String(regionId));

  if (status === 'not_available') {
    if (idx !== -1) return { openOutages, closedOutage: null };
    return { openOutages: [...openOutages, { region: regionId, startedAt: polledAt }], closedOutage: null };
  }

  if (idx !== -1 && RECOVERY_STATUSES.has(status)) {
    const entry = openOutages[idx];
    const durationMinutes = (polledAt.getTime() - entry.startedAt.getTime()) / 60000;
    return {
      openOutages: [...openOutages.slice(0, idx), ...openOutages.slice(idx + 1)],
      closedOutage: { region: regionId, start: entry.startedAt, end: polledAt, durationMinutes },
    };
  }

  // status === 'no_data' (or not_available with a streak already open):
  // ambiguous/unchanged, same passthrough computeOutages applies.
  return { openOutages, closedOutage: null };
}

/**
 * Per-station reliability metrics: availability share (excluding no_data),
 * outage count and average recovery time within the given range.
 */
async function getStationMetricsUncached(regionId, { from, to }) {
  const match = buildMatch(regionId, from, to);

  // $group by station instead of a raw find() + in-process loop - the raw
  // approach used to materialize every snapshot doc in the range as a JS
  // array (fine for a week, OOM-killed mongod on a real ~72-day report: see
  // this function's own git history) even though it's the exact same
  // $unwind+$group shape getAvailabilityTrend/getHeatmap already use safely
  // (just grouped by station instead of a time bucket) - nothing here needs
  // per-poll ordering, only outageCount/avgOutageMinutes below did, and
  // those now read from the separately-maintained StationOutage log instead
  // (see that model's own doc comment) rather than re-deriving streaks from
  // raw history on every request.
  const rows = await StationSnapshot.aggregate([
    { $match: match },
    ...CORE_FUEL_UNWIND_STAGES,
    { $group: { _id: '$station', ...STATUS_COUNTS_GROUP } },
  ]);
  // A station with zero core-fuel-type readings across the whole range
  // (sells only diesel/propane, say) never produces a row through the
  // $unwind above - same exclusion the old per-station loop applied by hand.
  if (!rows.length) return [];

  const stationIds = rows.map((row) => row._id);
  const stationDocs = await Station.find({ _id: { $in: stationIds } }, { name: 1, address: 1 }).lean();
  const stationInfoById = new Map(stationDocs.map((s) => [String(s._id), s]));

  // Scoped by region same as `match` above - a station in two overlapping
  // regions (Station.regions is an array) has independently-tracked outage
  // streaks per region (see Station.openOutages's own doc comment), so an
  // unscoped lookup here would double-count or misattribute outages from
  // the station's *other* region.
  const outageRows = await StationOutage.aggregate([
    { $match: { region: regionId, station: { $in: stationIds }, end: { $gte: from, $lte: to } } },
    { $group: { _id: '$station', outageCount: { $sum: 1 }, avgOutageMinutes: { $avg: '$durationMinutes' } } },
  ]);
  const outagesByStation = new Map(outageRows.map((row) => [String(row._id), row]));

  // The shrinkage target rankScore below pulls toward (see
  // scoreAvailability's doc comment) - pooled from the same per-station rows
  // just fetched (~100 of them), not a second pass over raw data.
  const regionTotals = { total: 0, available: 0, maybeAvailable: 0, notAvailable: 0, noData: 0 };
  for (const row of rows) {
    regionTotals.total += row.total;
    regionTotals.available += row.available;
    regionTotals.maybeAvailable += row.maybeAvailable;
    regionTotals.notAvailable += row.notAvailable;
    regionTotals.noData += row.noData;
  }
  const regionPrior = scoreAvailability(regionTotals);
  // Proportional to *this* query's own average known-reading count per
  // station (see AVAILABILITY_SHRINKAGE_FRACTION's doc comment) - an hourly
  // digest's ~6 known readings/station gets a correspondingly small m
  // instead of one calibrated for a 24h period's ~180.
  const shrinkM = shrinkageM((regionTotals.total - regionTotals.noData) / rows.length);

  return rows.map((row) => {
    const key = String(row._id);
    const info = stationInfoById.get(key);
    const outage = outagesByStation.get(key);
    return {
      stationId: row._id,
      name: info?.name ?? null,
      address: info?.address ?? null,
      totalPolls: row.total,
      outageCount: outage?.outageCount ?? 0,
      avgOutageMinutes: outage?.avgOutageMinutes ?? null,
      ...withKnownPct(row),
      // Overrides withKnownPct's own strict availablePct with the
      // maybe_available-weighted (but *not* shrunk) rate - this is what
      // gets printed next to a station's name, so it needs to always
      // match literal reality: a station with zero interruptions this
      // period must read 100%, full stop, not a discounted estimate a
      // reader has no way to see coming. See scoreAvailability's own doc
      // comment.
      availablePct: scoreAvailability(row),
      // The shrunk version - *only* for deciding which stations count as
      // "top"/"bottom" (ReportsView.vue's highlightedStations sort,
      // telegramDigestData's topAvailableStations), never printed as a
      // number itself. Reported live: the hourly Telegram digest's "Самые
      // доступные станции" showed three different stations all reading
      // 84% despite each having a literal 100% (zero-interruption) hour -
      // confusing because printing the *shrunk* figure conflates "the
      // number used to fairly rank you" with "your actual observed rate",
      // and a reader has no way to know those are two different things.
      // Splitting the fields keeps the anti-small-sample-luck protection
      // for *ranking* while every printed percentage stays literally true.
      rankScore: scoreAvailability(row, { prior: regionPrior, m: shrinkM }),
    };
  });
}

const getStationMetrics = memoizeAsync(getStationMetricsUncached, {
  ttlMs: METRICS_CACHE_TTL_MS,
  keyFn: (regionId, opts) => rangeKey(regionId, opts),
});

/**
 * Same reliability numbers as one row of getStationMetrics, but scoped to a
 * single station instead of a whole region - StationDetailModal.vue used to
 * call getStationMetrics for the station's *whole region* (up to ~101
 * stations' worth of raw history, ~2.7s cold on this region) just to pick
 * out one entry by id. Filtering by station instead of region hits the
 * pre-existing {station:1, polledAt:-1} index and only ever touches that
 * one station's own (much smaller) history.
 *
 * No shrinkage/regional prior here (unlike getStationMetrics's own
 * rankScore) - this function only ever answers "what's this one station's
 * own rate", never "does this station rank among the region's best/worst",
 * so there's nothing to protect against small-sample luck for. See
 * getStationMetricsUncached's own doc comment on why availablePct itself
 * is the plain, unshrunk rate now.
 */
async function getSingleStationMetricsUncached(stationId, { from, to }) {
  const match = { station: stationId };
  if (from || to) {
    match.polledAt = {};
    if (from) match.polledAt.$gte = from;
    if (to) match.polledAt.$lte = to;
  }

  const history = await StationSnapshot.find(match, { polledAt: 1, status: 1, fuelStatuses: 1 })
    .sort({ polledAt: 1 })
    .lean();
  if (!history.length) return null;

  const counts = { total: 0, available: 0, maybeAvailable: 0, notAvailable: 0, noData: 0 };
  for (const row of history) {
    for (const f of row.fuelStatuses || []) {
      if (!CORE_FUEL_TYPES.includes(f.fuelType)) continue;
      counts.total += 1;
      if (f.status === 'available') counts.available += 1;
      else if (f.status === 'maybe_available') counts.maybeAvailable += 1;
      else if (f.status === 'not_available') counts.notAvailable += 1;
      else if (f.status === 'no_data') counts.noData += 1;
    }
  }
  // Same "no core-fuel-type reading at all in range" exclusion
  // getStationMetrics applies - a diesel/propane-only station has nothing
  // meaningful to show here either.
  if (counts.total === 0) return null;

  const { outageCount, avgOutageMinutes } = computeOutages(history);
  return {
    stationId,
    totalPolls: counts.total,
    outageCount,
    avgOutageMinutes,
    ...withKnownPct(counts),
    availablePct: scoreAvailability(counts),
  };
}

const getSingleStationMetrics = memoizeAsync(getSingleStationMetricsUncached, {
  ttlMs: METRICS_CACHE_TTL_MS,
  keyFn: (stationId, opts) => rangeKey(stationId, opts),
});

/**
 * Average availability by ISO weekday (1=Mon..7=Sun) and hour-of-day (0-23)
 * in the given timezone - reveals patterns like "mornings before restock".
 */
async function getHeatmapUncached(regionId, { from, to, tz = DEFAULT_TZ }) {
  const match = buildMatch(regionId, from, to);

  const rows = await StationSnapshot.aggregate([
    { $match: match },
    {
      $addFields: {
        parts: { $dateToParts: { date: '$polledAt', timezone: tz, iso8601: true } },
      },
    },
    ...CORE_FUEL_UNWIND_STAGES,
    {
      $group: {
        _id: { weekday: '$parts.isoDayOfWeek', hour: '$parts.hour' },
        ...STATUS_COUNTS_GROUP,
      },
    },
    { $sort: { '_id.weekday': 1, '_id.hour': 1 } },
  ]);

  // No shrinkage here (unlike getStationMetrics's own rankScore) - a
  // heatmap cell isn't competing for a "top N" spot the way a station is,
  // and AvailabilityHeatmap.vue's own tooltip already prints `samples`
  // right next to the percentage, so a thin cell is self-evidently thin
  // instead of needing to be silently discounted.
  return rows.map((row) => ({
    weekday: row._id.weekday,
    hour: row._id.hour,
    samples: row.total,
    ...withKnownPct(row),
    // Overrides withKnownPct's own strict availablePct with the
    // maybe_available-weighted rate, same as getStationMetricsUncached's
    // own availablePct override (see that function's doc comment) - each
    // cell is one standalone headline number (AvailabilityHeatmap.vue
    // colors/labels it alone, never stacked against maybeAvailablePct).
    availablePct: scoreAvailability(row),
  }));
}

const getHeatmap = memoizeAsync(getHeatmapUncached, {
  ttlMs: METRICS_CACHE_TTL_MS,
  keyFn: (regionId, opts) => rangeKey(regionId, opts),
});

// Moscow has used a fixed UTC+3 offset with no DST since 2014 - same
// shortcut telegramPromoScheduler.js already relies on - so bucket
// boundaries can be computed with plain epoch-ms arithmetic shifted by a
// literal +3h, instead of pulling in a timezone-arithmetic library.
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

// Epoch-aligned truncation of `date` to the start of its own bucket, given
// the same {unit, binSize} shape getAvailabilityTrendUncached derives from
// bucketHours (see there) - not a byte-exact reproduction of Mongo's own
// $dateTrunc (which this function doesn't have access to for outages built
// in JS, not aggregated in Mongo), just a consistent, good-enough
// approximation so both trend charts land on comparably-sized buckets for
// the same bucketHours choice instead of one always stuck at daily
// regardless of what the other is showing.
function truncateToBucketStart(date, unit, binSize) {
  const bucketMs = (unit === 'hour' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000) * binSize;
  const localMs = date.getTime() + MOSCOW_OFFSET_MS;
  const truncatedLocalMs = Math.floor(localMs / bucketMs) * bucketMs;
  return new Date(truncatedLocalMs - MOSCOW_OFFSET_MS);
}

// Every expected bucket boundary between `from` and `to` at the given
// {unit, binSize} granularity, in order - $group (used by both
// getAvailabilityTrend and getRecoveryTrend below) only ever returns
// buckets that actually had a matching document, so a quiet stretch (no
// polls, or no outages) silently disappears from the result instead of
// showing as a zero. Reported live: that shrinks whichever chart hit the
// gap down to fewer points than its sibling drawn right below it on the
// reports page - both stretch however many points they got across the same
// container width, so a quiet week made "Время восстановления" noticeably
// narrower-spaced than "Динамика доступности" right above it even though
// both cover the exact same period. Filling every boundary on both call
// sites keeps their bucket counts equal so the same date lands at the same
// x position in both - the same "fill every boundary" fix
// getAvailabilitySeries already applies for its own (different, minute-
// granularity) buckets. Reuses truncateToBucketStart's fixed-Moscow-offset
// math for the first boundary (accurate for every real caller - none of
// them ever pass a tz other than the Moscow default) rather than
// replicating $dateTrunc's own general timezone handling here.
function enumerateBucketStarts(from, to, unit, binSize) {
  const bucketMs = (unit === 'hour' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000) * binSize;
  const starts = [];
  let t = truncateToBucketStart(from, unit, binSize).getTime();
  const endMs = to.getTime();
  while (t < endMs) {
    starts.push(new Date(t));
    t += bucketMs;
  }
  return starts;
}

// Two cheap indexed nearest-neighbor lookups (StationSnapshot's own
// {region:1, polledAt:-1}-shaped index) - not a full range scan, just "does
// this region have ANY snapshot at all within this match, and where do they
// start/end." Used to clamp enumerateBucketStarts to where the region
// actually *has* history instead of the raw requested from/to: a report
// reaching back past when the region started being tracked used to
// synthesize a long leading run of genuinely-nonexistent "no data" buckets
// (not the legitimate "tracked but quiet" gaps this whole gap-fill exists
// for) - reported live, Chart.js's stacked-area rendering visibly broke
// down over a ~25-day leading run of those on a 90-day report, compressing
// the real data into a fraction of the chart's own width instead of simply
// not extending back that far. Both getAvailabilityTrendUncached and
// getRecoveryTrendUncached call this (the latter reads StationOutage, which
// has no bound of its own to give - an outage-free week is real data, not
// missing data, so it can't supply "where did tracking start" the way
// StationSnapshot can) so their clamped bounds - and therefore their
// bucket counts - always agree, not just approximately.
async function getSnapshotDataBounds(match) {
  const [earliest, latest] = await Promise.all([
    StationSnapshot.findOne(match, { polledAt: 1 }).sort({ polledAt: 1 }).lean(),
    StationSnapshot.findOne(match, { polledAt: 1 }).sort({ polledAt: -1 }).lean(),
  ]);
  if (!earliest) return null;
  return { min: earliest.polledAt, max: latest.polledAt };
}

/**
 * Region-wide average recovery time, bucketed the same way
 * getAvailabilityTrend's own bucketHours does (hour buckets for a short
 * window, day/week for a longer one - see that function's own unit/binSize
 * derivation, mirrored here) - "is it taking longer or shorter to come back
 * after running out" over the period, a complement to that trend's "how
 * often is it available". That one counts snapshots directly via a Mongo
 * aggregation; an outage is a streak spanning several snapshots, so this
 * instead re-uses computeOutages per station (same approach
 * getStationMetricsUncached already takes for the aggregate outageCount/
 * avgOutageMinutes) and buckets each individual outage by the moment it
 * *ended* (when a driver would have actually noticed fuel was back), not
 * when it started.
 *
 * Verified live this was worth doing, not just cosmetic: with bucketHours
 * fixed at "always a day" (an earlier version of this function), a 24h
 * selection showed 2 sparse day-bars next to the availability chart's dozen
 * hourly points right above it, and a 30-day selection showed the same
 * several daily bars as a 7-day one instead of the coarser weekly view the
 * availability chart itself switches to - both read as "this chart is
 * broken" even though the underlying data was correct.
 */
async function getRecoveryTrendUncached(regionId, { from, to, bucketHours = 24, tz = DEFAULT_TZ }) {
  const unit = bucketHours >= 24 && bucketHours % 24 === 0 ? 'day' : 'hour';
  const binSize = unit === 'day' ? bucketHours / 24 : bucketHours;

  // Same clamp-to-where-the-region-actually-has-history as
  // getAvailabilityTrendUncached, from the exact same source
  // (StationSnapshot, via getSnapshotDataBounds) so both functions land on
  // identical bounds - an outage-free stretch is real data this function
  // can't tell apart from "not tracked yet" on its own (StationOutage has
  // no rows either way), so it borrows StationSnapshot's own answer to that
  // rather than guessing from its own (silent either way) result.
  const bounds = await getSnapshotDataBounds(buildMatch(regionId, from, to));
  if (!bounds) return [];

  // $group/$dateTrunc directly over the persisted StationOutage log (see
  // that model's own doc comment) instead of a raw StationSnapshot find() +
  // per-station computeOutages loop - the old approach re-derived every
  // outage streak in the range from scratch on every request, the same
  // OOM-risking pattern getStationMetricsUncached used to have. The actual
  // grouping below uses Mongo's own tz-aware $dateTrunc, not the JS
  // truncateToBucketStart approximation - that one only comes back in via
  // enumerateBucketStarts further down, purely to enumerate the boundaries
  // to gap-fill, not to redo the grouping itself.
  const rows = await StationOutage.aggregate([
    { $match: { region: regionId, end: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: { $dateTrunc: { date: '$end', unit, binSize, timezone: tz } },
        totalMinutes: { $sum: '$durationMinutes' },
        outageCount: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  const rowByBucketStartMs = new Map(rows.map((row) => [row._id.getTime(), row]));

  // Fills every expected boundary, not just ones $group actually returned
  // (a quiet stretch with zero outages is real, common data, not an
  // exceptional case) - see enumerateBucketStarts' own doc comment for why
  // this keeps this chart's bucket count in sync with getAvailabilityTrend's
  // own, so the two line up on the reports page instead of drifting apart.
  return enumerateBucketStarts(bounds.min, new Date(bounds.max.getTime() + 1), unit, binSize).map((bucketStart) => {
    const row = rowByBucketStartMs.get(bucketStart.getTime());
    return {
      bucketStart,
      avgRecoveryMinutes: row ? row.totalMinutes / row.outageCount : null,
      outageCount: row ? row.outageCount : 0,
    };
  });
}

const getRecoveryTrend = memoizeAsync(getRecoveryTrendUncached, {
  ttlMs: METRICS_CACHE_TTL_MS,
  keyFn: (regionId, opts) => rangeKey(regionId, opts),
});

module.exports = {
  getCurrentSnapshot,
  getAvailabilityTrend,
  getStationTrend,
  getAvailabilitySeries,
  getStationMetrics,
  getSingleStationMetrics,
  getHeatmap,
  getRecoveryTrend,
  computeOutages,
  // Shared with ingestService.js's incremental outage-tracking hook (see
  // Station.openOutages's own doc comment) so the two "what counts as
  // recovered" rules can't drift apart - computeOutages's raw-history scan
  // and the incremental state machine must agree byte-for-byte.
  advanceOutageStreak,
  RECOVERY_STATUSES,
  CORE_FUEL_TYPES,
  deriveCoreStatus,
  METRICS_CACHE_TTL_MS,
  truncateToBucketStart,
  enumerateBucketStarts,
  // Exported so every other "one number that matters" availability
  // computation in the app (telegramDigestData.js/telegramAlertMapImage.js's
  // current-snapshot percentages today) uses the exact same
  // maybe_available weight instead of a second hardcoded 0.7 that could
  // drift from this one - see MAYBE_AVAILABLE_WEIGHT's own doc comment for
  // why 0.7. Those particular call sites are cross-sectional (many
  // stations at one instant, not one entity's history), so they don't need
  // scoreAvailability's shrinkage - just the same weight.
  MAYBE_AVAILABLE_WEIGHT,
};
