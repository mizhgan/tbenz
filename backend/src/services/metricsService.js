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

const STATUS_COUNTS_GROUP = {
  total: { $sum: 1 },
  available: { $sum: { $cond: [{ $eq: ['$status', 'available'] }, 1, 0] } },
  maybeAvailable: { $sum: { $cond: [{ $eq: ['$status', 'maybe_available'] }, 1, 0] } },
  notAvailable: { $sum: { $cond: [{ $eq: ['$status', 'not_available'] }, 1, 0] } },
  noData: { $sum: { $cond: [{ $eq: ['$status', 'no_data'] }, 1, 0] } },
};

/**
 * The most recent snapshot at or before `at`, per station in the region -
 * "what does the region look like right now" rather than an aggregate over
 * a period. Shared by the region-snapshot endpoint (map's live/at-time view)
 * and the Telegram digest (current status breakdown).
 */
async function getCurrentSnapshot(regionId, at) {
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
      // Only sources this station is actually matched to (a registered but
      // unmatched source contributes no entry, not a null-status one).
      sources: {
        $filter: {
          input: infoFields.map(({ key, field }) => ({
            key,
            status: { $ifNull: [`$${field}.status`, null] },
          })),
          cond: { $ne: ['$$this.status', null] },
        },
      },
    },
  });

  return StationSnapshot.aggregate(pipeline);
}

/**
 * Region-wide availability trend, bucketed into fixed-size time windows.
 */
async function getAvailabilityTrendUncached(regionId, { from, to, bucketHours = 24, tz = DEFAULT_TZ }) {
  const match = buildMatch(regionId, from, to);
  const unit = bucketHours >= 24 && bucketHours % 24 === 0 ? 'day' : 'hour';
  const binSize = unit === 'day' ? bucketHours / 24 : bucketHours;

  const rows = await StationSnapshot.aggregate([
    { $match: match },
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
function computeOutages(history) {
  let outageCount = 0;
  let totalOutageMs = 0;
  let outageStartedAt = null;

  for (const snap of history) {
    if (snap.status === 'not_available') {
      if (outageStartedAt === null) outageStartedAt = snap.polledAt;
    } else if (outageStartedAt !== null && RECOVERY_STATUSES.has(snap.status)) {
      totalOutageMs += snap.polledAt.getTime() - outageStartedAt.getTime();
      outageCount += 1;
      outageStartedAt = null;
    }
    // status === 'no_data' while an outage is open: ambiguous, keep waiting.
  }

  return {
    outageCount,
    avgOutageMinutes: outageCount > 0 ? totalOutageMs / outageCount / 60000 : null,
  };
}

/**
 * Per-station reliability metrics: availability share (excluding no_data),
 * outage count and average recovery time within the given range.
 */
async function getStationMetricsUncached(regionId, { from, to }) {
  const match = buildMatch(regionId, from, to);

  const countRows = await StationSnapshot.aggregate([
    { $match: match },
    { $group: { _id: '$station', ...STATUS_COUNTS_GROUP } },
  ]);
  if (!countRows.length) return [];

  const historyRows = await StationSnapshot.find(match, { station: 1, polledAt: 1, status: 1 })
    .sort({ station: 1, polledAt: 1 })
    .lean();

  const historyByStation = new Map();
  for (const row of historyRows) {
    const key = String(row.station);
    if (!historyByStation.has(key)) historyByStation.set(key, []);
    historyByStation.get(key).push(row);
  }

  const stationDocs = await Station.find(
    { _id: { $in: countRows.map((r) => r._id) } },
    { name: 1, address: 1 }
  ).lean();
  const stationInfoById = new Map(stationDocs.map((s) => [String(s._id), s]));

  return countRows.map((row) => {
    const key = String(row._id);
    const info = stationInfoById.get(key);
    const { outageCount, avgOutageMinutes } = computeOutages(historyByStation.get(key) || []);
    return {
      stationId: row._id,
      name: info?.name ?? null,
      address: info?.address ?? null,
      totalPolls: row.total,
      outageCount,
      avgOutageMinutes,
      ...withKnownPct(row),
    };
  });
}

const getStationMetrics = memoizeAsync(getStationMetricsUncached, {
  ttlMs: METRICS_CACHE_TTL_MS,
  keyFn: (regionId, opts) => rangeKey(regionId, opts),
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
    {
      $group: {
        _id: { weekday: '$parts.isoDayOfWeek', hour: '$parts.hour' },
        ...STATUS_COUNTS_GROUP,
      },
    },
    { $sort: { '_id.weekday': 1, '_id.hour': 1 } },
  ]);

  return rows.map((row) => ({
    weekday: row._id.weekday,
    hour: row._id.hour,
    samples: row.total,
    ...withKnownPct(row),
  }));
}

const getHeatmap = memoizeAsync(getHeatmapUncached, {
  ttlMs: METRICS_CACHE_TTL_MS,
  keyFn: (regionId, opts) => rangeKey(regionId, opts),
});

module.exports = {
  getCurrentSnapshot,
  getAvailabilityTrend,
  getAvailabilitySeries,
  getStationMetrics,
  getBrandMetrics,
  getHeatmap,
  computeOutages,
};
