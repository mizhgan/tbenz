const StationSnapshot = require('../models/StationSnapshot');
const { computeOutages, getAvailabilityTrend } = require('./metricsService');

const DEFAULT_TZ = 'Europe/Moscow';
const WEEKDAY_MAP = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/**
 * ISO weekday (1=Mon..7=Sun) and hour-of-day (0-23) for an instant, in a
 * given IANA timezone, using Intl instead of an extra date library.
 */
function isoWeekdayAndHour(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const weekdayShort = parts.find((p) => p.type === 'weekday').value;
  const hourPart = parts.find((p) => p.type === 'hour').value;
  // Some locale/timezone combinations render midnight as "24" instead of "0".
  const hour = hourPart === '24' ? 0 : Number(hourPart);
  return { weekday: WEEKDAY_MAP[weekdayShort], hour };
}

/**
 * Historical share of "available" readings (of known-status readings) for
 * each (weekday, hour) slot the station has ever been polled in, over the
 * lookback window. This is the same idea as the region heatmap, scoped to
 * one station and read back out per-slot for forecasting.
 */
async function getStationHourlyProfile(stationId, { lookbackDays = 28, tz = DEFAULT_TZ } = {}) {
  const from = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  const rows = await StationSnapshot.aggregate([
    { $match: { station: stationId, polledAt: { $gte: from } } },
    { $addFields: { parts: { $dateToParts: { date: '$polledAt', timezone: tz, iso8601: true } } } },
    {
      $group: {
        _id: { weekday: '$parts.isoDayOfWeek', hour: '$parts.hour' },
        total: { $sum: 1 },
        available: { $sum: { $cond: [{ $eq: ['$status', 'available'] }, 1, 0] } },
        noData: { $sum: { $cond: [{ $eq: ['$status', 'no_data'] }, 1, 0] } },
      },
    },
  ]);

  const profile = new Map();
  let overallKnown = 0;
  let overallAvailable = 0;
  for (const row of rows) {
    const known = row.total - row.noData;
    if (known > 0) {
      profile.set(`${row._id.weekday}-${row._id.hour}`, {
        availablePct: (row.available / known) * 100,
        samples: known,
      });
      overallKnown += known;
      overallAvailable += row.available;
    }
  }

  return {
    profile,
    overallAvailablePct: overallKnown > 0 ? (overallAvailable / overallKnown) * 100 : null,
  };
}

/**
 * How long the station has been continuously in its latest-known status,
 * walked backwards from the most recent snapshot. Capped to the last 500
 * snapshots for a station that has been stable for a very long time - the
 * "since" timestamp in that case is a lower bound, not exact.
 */
async function getCurrentStatusStreak(stationId) {
  const recent = await StationSnapshot.find({ station: stationId })
    .sort({ polledAt: -1 })
    .limit(500)
    .select('status polledAt')
    .lean();
  if (!recent.length) return null;

  const currentStatus = recent[0].status;
  let since = recent[0].polledAt;
  for (const snap of recent) {
    if (snap.status !== currentStatus) break;
    since = snap.polledAt;
  }
  return { status: currentStatus, since };
}

async function getStationRecoveryStats(stationId, { lookbackDays = 28 } = {}) {
  const from = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const history = await StationSnapshot.find({ station: stationId, polledAt: { $gte: from } })
    .sort({ polledAt: 1 })
    .select('status polledAt')
    .lean();
  return computeOutages(history);
}

/**
 * Forecasts, for the next `hoursAhead` hours, the station's estimated
 * availability probability - read directly off its own historical
 * (weekday, hour) profile, falling back to its overall average when a slot
 * has no history yet. If the station is currently down, also estimates a
 * recovery time from its historical average outage duration.
 *
 * This is a simple empirical/frequentist estimate, not a fitted model - it
 * assumes the recent past (last `lookbackDays` days) is representative of
 * the near future, which is a reasonable but not guaranteed assumption.
 */
async function getStationForecast(stationId, { hoursAhead = 24, lookbackDays = 28, tz = DEFAULT_TZ } = {}) {
  const [{ profile, overallAvailablePct }, streak] = await Promise.all([
    getStationHourlyProfile(stationId, { lookbackDays, tz }),
    getCurrentStatusStreak(stationId),
  ]);

  const now = Date.now();
  const hours = [];
  for (let i = 1; i <= hoursAhead; i++) {
    const at = new Date(now + i * 60 * 60 * 1000);
    const { weekday, hour } = isoWeekdayAndHour(at, tz);
    const cell = profile.get(`${weekday}-${hour}`);
    hours.push({
      at,
      weekday,
      hour,
      availablePct: cell ? cell.availablePct : overallAvailablePct,
      samples: cell ? cell.samples : 0,
      basis: cell ? 'history' : overallAvailablePct !== null ? 'overall-average' : 'no-data',
    });
  }

  let estimatedRecoveryAt = null;
  if (streak && streak.status === 'not_available') {
    const { avgOutageMinutes } = await getStationRecoveryStats(stationId, { lookbackDays });
    if (avgOutageMinutes !== null) {
      estimatedRecoveryAt = new Date(streak.since.getTime() + avgOutageMinutes * 60000);
    }
  }

  return {
    currentStatus: streak?.status ?? null,
    currentStatusSince: streak?.since ?? null,
    estimatedRecoveryAt,
    overallAvailablePct,
    hours,
  };
}

function linearRegression(points) {
  const valid = points.filter((p) => Number.isFinite(p.y));
  const n = valid.length;
  if (n < 2) return null;

  const sumX = valid.reduce((s, p) => s + p.x, 0);
  const sumY = valid.reduce((s, p) => s + p.y, 0);
  const sumXY = valid.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = valid.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;

  return {
    slope: (n * sumXY - sumX * sumY) / denom,
    intercept: (sumY - ((n * sumXY - sumX * sumY) / denom) * sumX) / n,
  };
}

const SLOPE_THRESHOLD_PCT_PER_BUCKET = 1;

/**
 * Naive linear extrapolation of the region's recent availability trend -
 * NOT a real time-series model (no seasonality, no confidence interval),
 * just a rough "is it getting better or worse" signal with a projected
 * continuation of the line, clamped to a valid percentage range.
 */
async function getRegionTrendForecast(regionId, { from, to, bucketHours = 24, bucketsAhead = 6, tz } = {}) {
  const buckets = await getAvailabilityTrend(regionId, { from, to, bucketHours, tz });

  if (buckets.length < 3) {
    return { direction: 'unknown', slopePerBucket: null, buckets, forecast: [] };
  }

  const points = buckets.map((b, i) => ({ x: i, y: b.availablePct }));
  const reg = linearRegression(points);
  if (!reg) {
    return { direction: 'unknown', slopePerBucket: null, buckets, forecast: [] };
  }

  const lastBucketStartMs = buckets[buckets.length - 1].bucketStart.getTime();
  const bucketMs = bucketHours * 60 * 60 * 1000;
  const forecast = [];
  for (let i = 1; i <= bucketsAhead; i++) {
    const x = buckets.length - 1 + i;
    const yRaw = reg.slope * x + reg.intercept;
    forecast.push({
      bucketStart: new Date(lastBucketStartMs + i * bucketMs),
      availablePct: Math.max(0, Math.min(100, yRaw)),
    });
  }

  const direction =
    reg.slope > SLOPE_THRESHOLD_PCT_PER_BUCKET
      ? 'improving'
      : reg.slope < -SLOPE_THRESHOLD_PCT_PER_BUCKET
        ? 'worsening'
        : 'stable';

  return { direction, slopePerBucket: reg.slope, buckets, forecast };
}

module.exports = {
  getStationForecast,
  getRegionTrendForecast,
  linearRegression,
  isoWeekdayAndHour,
};
