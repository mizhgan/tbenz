const StationSnapshot = require('../models/StationSnapshot');
const Station = require('../models/Station');
const { listSources } = require('./sourceRegistry');
const { memoizeAsync } = require('../utils/cache');

const DEFAULT_TZ = 'Europe/Moscow';

// Snapshots land every pollIntervalMinutes (10 by default), so recomputing
// these aggregations more than once every few minutes buys nothing but load.
// A short TTL plus in-flight dedup is enough to collapse both same-user
// re-renders and the reports page's own redundant internal calls (e.g.
// getBrandMetrics -> getStationMetrics) into a single query.
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

// How many "known" readings count as enough evidence to mostly trust a
// station/cell's own raw rate over the regional average - see
// scoreAvailability's own doc comment. 60 is roughly a third of a typical
// station's full-day known-reading count (~180, two core fuel types polled
// every ~15min) - a full day of data is barely pulled toward the prior,
// a couple of hours' worth is pulled hard.
const AVAILABILITY_SHRINKAGE_M = 60;

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
//    rate for the same period (see getRegionAvailabilityPrior below);
//    omitting `prior` returns the plain unshrunk rate, which is what
//    getRegionAvailabilityPrior itself uses to compute that regional
//    baseline in the first place (it can't shrink towards itself).
function scoreAvailability(row, { prior = null, m = AVAILABILITY_SHRINKAGE_M } = {}) {
  const known = row.total - row.noData;
  if (known <= 0) return prior;
  const raw = ((row.available + MAYBE_AVAILABLE_WEIGHT * row.maybeAvailable) / known) * 100;
  if (prior === null) return raw;
  const weight = known / (known + m);
  return weight * raw + (1 - weight) * prior;
}

/**
 * The region's own overall availability rate (same scoreAvailability
 * formula, unshrunk) for a period - the shrinkage target every per-station/
 * per-cell score in this file pulls toward when it doesn't have much
 * evidence of its own. Deliberately a *separate*, cheap, single-row
 * aggregation (server-side $group, not a raw per-document fetch) rather
 * than reusing getStationMetrics's own per-station breakdown - computing
 * this from getSingleStationMetrics would mean scanning the whole region
 * just to answer one station's question again, exactly the cost that
 * function exists to avoid (see its own doc comment). Memoized on the same
 * rounded region+range key as everything else in this file, so in practice
 * it's a cache hit for all but the first caller in any 5-minute window.
 */
async function getRegionAvailabilityPriorUncached(regionId, { from, to }) {
  const match = buildMatch(regionId, from, to);
  const [row] = await StationSnapshot.aggregate([
    { $match: match },
    ...CORE_FUEL_UNWIND_STAGES,
    { $group: { _id: null, ...STATUS_COUNTS_GROUP } },
  ]);
  if (!row) return null;
  return scoreAvailability(row);
}

const getRegionAvailabilityPrior = memoizeAsync(getRegionAvailabilityPriorUncached, {
  ttlMs: METRICS_CACHE_TTL_MS,
  keyFn: (regionId, opts) => rangeKey(regionId, opts),
});

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

  return rows.map((row) => ({
    bucketStart: row._id,
    total: row.total,
    available: row.available,
    maybeAvailable: row.maybeAvailable,
    notAvailable: row.notAvailable,
    noData: row.noData,
    ...withKnownPct(row),
  }));
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
  };
}

/**
 * Per-station reliability metrics: availability share (excluding no_data),
 * outage count and average recovery time within the given range.
 */
async function getStationMetricsUncached(regionId, { from, to }) {
  const match = buildMatch(regionId, from, to);

  // One fetch, not two: this used to run a separate $unwind+$group
  // aggregation for the per-fuel-type counts *and* a full raw find() for
  // computeOutages's own sequential scan - both reading the exact same
  // ~region x date-range set of documents (measured live on a 7-day/101-
  // station region: ~66k docs, ~900ms for the raw find alone, the
  // aggregation pass comparable). The raw docs already carry everything
  // both steps need, so this reads them once and does the unwind-equivalent
  // counting in-process instead of paying for a second Mongo round trip
  // over the same data - this was the single biggest contributor to the
  // reports page's slow first load (see this function's own git history).
  const historyRows = await StationSnapshot.find(match, { station: 1, polledAt: 1, status: 1, fuelStatuses: 1 })
    .sort({ station: 1, polledAt: 1 })
    .lean();
  if (!historyRows.length) return [];

  const byStation = new Map();
  for (const row of historyRows) {
    const key = String(row.station);
    let bucket = byStation.get(key);
    if (!bucket) {
      bucket = {
        stationId: row.station,
        // Outage/recovery-time below is deliberately still based on each
        // snapshot's one blanket overall `status`, not CORE_FUEL_TYPES -
        // "how long was the station down" is a per-station timeline
        // question (a discrete start/end streak), and there's no settled
        // answer yet for what a per-fuel-type version of the same question
        // would even mean (does 92 going down while 95 stays up count as
        // an outage?) - a separate design question from availablePct
        // below, left alone for now.
        history: [],
        counts: { total: 0, available: 0, maybeAvailable: 0, notAvailable: 0, noData: 0 },
      };
      byStation.set(key, bucket);
    }
    bucket.history.push(row);
    // Same "one vote per core-fuel-type reading, zero votes for a snapshot
    // with no 92/95 reading at all" rule CORE_FUEL_UNWIND_STAGES used to
    // enforce via $unwind - a diesel/propane-only snapshot contributes
    // nothing here either.
    for (const f of row.fuelStatuses || []) {
      if (!CORE_FUEL_TYPES.includes(f.fuelType)) continue;
      bucket.counts.total += 1;
      if (f.status === 'available') bucket.counts.available += 1;
      else if (f.status === 'maybe_available') bucket.counts.maybeAvailable += 1;
      else if (f.status === 'not_available') bucket.counts.notAvailable += 1;
      else if (f.status === 'no_data') bucket.counts.noData += 1;
    }
  }

  // A station with zero core-fuel-type readings across the whole range
  // (sells only diesel/propane, say) produced zero rows through the old
  // $unwind and so never appeared in its $group output either - matched
  // here by dropping any bucket whose counts.total never left 0, rather
  // than returning it with an all-null availability line that never used
  // to exist.
  const stationIds = [];
  for (const [key, bucket] of byStation) {
    if (bucket.counts.total === 0) byStation.delete(key);
    else stationIds.push(bucket.stationId);
  }
  if (!stationIds.length) return [];

  const stationDocs = await Station.find({ _id: { $in: stationIds } }, { name: 1, address: 1 }).lean();
  const stationInfoById = new Map(stationDocs.map((s) => [String(s._id), s]));

  // The shrinkage target every station's own score below pulls toward (see
  // scoreAvailability's doc comment) - computed by pooling the exact same
  // per-station counts already sitting in `byStation` rather than issuing a
  // second aggregation for the same data (unlike getSingleStationMetrics/
  // getHeatmap, which don't already have the whole region's raw rows in
  // memory and go through the cached getRegionAvailabilityPrior instead).
  const regionTotals = { total: 0, available: 0, maybeAvailable: 0, notAvailable: 0, noData: 0 };
  for (const bucket of byStation.values()) {
    regionTotals.total += bucket.counts.total;
    regionTotals.available += bucket.counts.available;
    regionTotals.maybeAvailable += bucket.counts.maybeAvailable;
    regionTotals.notAvailable += bucket.counts.notAvailable;
    regionTotals.noData += bucket.counts.noData;
  }
  const regionPrior = scoreAvailability(regionTotals);

  return [...byStation.values()].map((bucket) => {
    const key = String(bucket.stationId);
    const info = stationInfoById.get(key);
    const { outageCount, avgOutageMinutes } = computeOutages(bucket.history);
    return {
      stationId: bucket.stationId,
      name: info?.name ?? null,
      address: info?.address ?? null,
      totalPolls: bucket.counts.total,
      outageCount,
      avgOutageMinutes,
      ...withKnownPct(bucket.counts),
      // Overrides withKnownPct's own (strict) availablePct - this is a
      // single per-station headline number (the reports page's ranking/
      // "Доступность" column), not a stacked chart series, so it gets the
      // full scoring treatment: maybe_available at partial weight, shrunk
      // toward the region's own rate when this station doesn't have much
      // evidence of its own. See scoreAvailability's own doc comment.
      availablePct: scoreAvailability(bucket.counts, { prior: regionPrior }),
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
 * `regionId` is only used to look up the shrinkage prior (see
 * scoreAvailability/getRegionAvailabilityPrior) - that's a separate, cheap,
 * cached aggregation, not a re-scan of the region's raw history, so this
 * still doesn't pay getStationMetrics's own cost.
 */
async function getSingleStationMetricsUncached(stationId, regionId, { from, to }) {
  const match = { station: stationId };
  if (from || to) {
    match.polledAt = {};
    if (from) match.polledAt.$gte = from;
    if (to) match.polledAt.$lte = to;
  }

  const [history, regionPrior] = await Promise.all([
    StationSnapshot.find(match, { polledAt: 1, status: 1, fuelStatuses: 1 }).sort({ polledAt: 1 }).lean(),
    getRegionAvailabilityPrior(regionId, { from, to }),
  ]);
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
    // See getStationMetricsUncached's identical override just above -
    // same single-headline-number case.
    availablePct: scoreAvailability(counts, { prior: regionPrior }),
  };
}

const getSingleStationMetrics = memoizeAsync(getSingleStationMetricsUncached, {
  ttlMs: METRICS_CACHE_TTL_MS,
  keyFn: (stationId, regionId, opts) => `${rangeKey(stationId, opts)}:${String(regionId)}`,
});

/**
 * Availability grouped by station "name" (the source's brand/network field,
 * e.g. "Лукойл", "Роснефть") - built on top of per-station metrics rather
 * than a separate query, since the grouping key lives on Station, not the
 * snapshot.
 */
async function getBrandMetrics(regionId, range) {
  const stations = await getStationMetrics(regionId, range);
  const byName = new Map();

  for (const s of stations) {
    const key = s.name || 'Без названия';
    if (!byName.has(key)) {
      byName.set(key, { name: key, stationCount: 0, sumAvailablePct: 0, countWithData: 0 });
    }
    const entry = byName.get(key);
    entry.stationCount += 1;
    if (s.availablePct !== null) {
      entry.sumAvailablePct += s.availablePct;
      entry.countWithData += 1;
    }
  }

  return Array.from(byName.values())
    .map((e) => ({
      name: e.name,
      stationCount: e.stationCount,
      avgAvailablePct: e.countWithData > 0 ? e.sumAvailablePct / e.countWithData : null,
    }))
    .sort((a, b) => (b.avgAvailablePct ?? -1) - (a.avgAvailablePct ?? -1));
}

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

  // Same "pool what's already in hand instead of a second query" approach
  // getStationMetricsUncached uses for its own regionPrior - these rows
  // already cover the whole region's data for the period, just grouped by
  // weekday/hour instead of by station.
  const regionTotals = { total: 0, available: 0, maybeAvailable: 0, notAvailable: 0, noData: 0 };
  for (const row of rows) {
    regionTotals.total += row.total;
    regionTotals.available += row.available;
    regionTotals.maybeAvailable += row.maybeAvailable;
    regionTotals.notAvailable += row.notAvailable;
    regionTotals.noData += row.noData;
  }
  const regionPrior = scoreAvailability(regionTotals);

  return rows.map((row) => ({
    weekday: row._id.weekday,
    hour: row._id.hour,
    samples: row.total,
    ...withKnownPct(row),
    // Each cell is one standalone headline number (AvailabilityHeatmap.vue
    // colors/labels it alone, never stacked against maybeAvailablePct) -
    // same scoring+shrinkage as getStationMetricsUncached above, for the
    // same reason (a specific weekday+hour cell can easily have a small
    // sample too).
    availablePct: scoreAvailability(row, { prior: regionPrior }),
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
async function getRecoveryTrendUncached(regionId, { from, to, bucketHours = 24 }) {
  const unit = bucketHours >= 24 && bucketHours % 24 === 0 ? 'day' : 'hour';
  const binSize = unit === 'day' ? bucketHours / 24 : bucketHours;

  const match = buildMatch(regionId, from, to);
  const historyRows = await StationSnapshot.find(match, { station: 1, polledAt: 1, status: 1 })
    .sort({ station: 1, polledAt: 1 })
    .lean();

  const historyByStation = new Map();
  for (const row of historyRows) {
    const key = String(row.station);
    if (!historyByStation.has(key)) historyByStation.set(key, []);
    historyByStation.get(key).push(row);
  }

  const byBucket = new Map(); // bucketStart ms -> { totalMinutes, outageCount }
  for (const history of historyByStation.values()) {
    const { outages } = computeOutages(history);
    for (const outage of outages) {
      const bucketStart = truncateToBucketStart(outage.end, unit, binSize);
      const key = bucketStart.getTime();
      const entry = byBucket.get(key) || { totalMinutes: 0, outageCount: 0 };
      entry.totalMinutes += outage.durationMinutes;
      entry.outageCount += 1;
      byBucket.set(key, entry);
    }
  }

  return Array.from(byBucket.entries())
    .map(([bucketStartMs, entry]) => ({
      bucketStart: new Date(bucketStartMs),
      avgRecoveryMinutes: entry.totalMinutes / entry.outageCount,
      outageCount: entry.outageCount,
    }))
    .sort((a, b) => a.bucketStart - b.bucketStart);
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
  getBrandMetrics,
  getHeatmap,
  getRecoveryTrend,
  computeOutages,
  CORE_FUEL_TYPES,
  deriveCoreStatus,
  METRICS_CACHE_TTL_MS,
  truncateToBucketStart,
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
