const StationSnapshot = require('../models/StationSnapshot');
const {
  computeOutages,
  getAvailabilityTrend,
  getStationTrend,
  CORE_FUEL_TYPES,
  METRICS_CACHE_TTL_MS,
} = require('./metricsService');
const { memoizeAsync } = require('../utils/cache');

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
 * each (weekday, hour) slot, per station, over the lookback window - for
 * every station in `stationIds` in a single aggregation (grouped by
 * station+weekday+hour) rather than one query per station.
 *
 * Used only by the bulk predictive-alert scan (telegramPredictiveAlerts.js)
 * now - the station card's own hourly forecast (getStationForecast below)
 * moved off this seasonal model onto a short-term trend extrapolation
 * instead (see that function's own doc comment for why). Left as-is here
 * rather than also changed, to keep this fix scoped to what was actually
 * reported (the station card) - the predictive-alert scan has the same
 * cold-start/wrong-model-class concerns, just not addressed yet.
 *
 * Pools each snapshot's own reading for CORE_FUEL_TYPES (92/95), same as
 * metricsService.js's reliability/trend/heatmap numbers this modal's
 * "Надёжность" tile already shows next to this forecast - not each
 * snapshot's one blanket overall `status`, which would otherwise make the
 * forecast disagree with the tile right above it. A station with no core-3
 * reading at all (pure propane/methane AGZS) drops out entirely (empty
 * profile, overallAvailablePct null) rather than forecasting off data that
 * was never about 92/95.
 */
async function getBulkHourlyProfiles(stationIds, { lookbackDays = 28, tz = DEFAULT_TZ } = {}) {
  const from = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  const rows = await StationSnapshot.aggregate([
    { $match: { station: { $in: stationIds }, polledAt: { $gte: from } } },
    { $addFields: { parts: { $dateToParts: { date: '$polledAt', timezone: tz, iso8601: true } } } },
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
    {
      $group: {
        _id: { station: '$station', weekday: '$parts.isoDayOfWeek', hour: '$parts.hour' },
        total: { $sum: 1 },
        available: { $sum: { $cond: [{ $eq: ['$coreFuelStatuses.status', 'available'] }, 1, 0] } },
        noData: { $sum: { $cond: [{ $eq: ['$coreFuelStatuses.status', 'no_data'] }, 1, 0] } },
      },
    },
  ]);

  const byStation = new Map();
  for (const row of rows) {
    const key = String(row._id.station);
    if (!byStation.has(key)) {
      byStation.set(key, { profile: new Map(), overallKnown: 0, overallAvailable: 0 });
    }
    const entry = byStation.get(key);
    const known = row.total - row.noData;
    if (known > 0) {
      entry.profile.set(`${row._id.weekday}-${row._id.hour}`, {
        availablePct: (row.available / known) * 100,
        samples: known,
      });
      entry.overallKnown += known;
      entry.overallAvailable += row.available;
    }
  }

  const result = new Map();
  for (const [key, entry] of byStation) {
    result.set(key, {
      profile: entry.profile,
      overallAvailablePct: entry.overallKnown > 0 ? (entry.overallAvailable / entry.overallKnown) * 100 : null,
    });
  }
  return result;
}

/**
 * Estimated availability for a single hour, read off a station's (weekday,
 * hour) profile - falls back to the station's overall average when that
 * slot has no history yet. Extracted so the bulk predictive-alert scan can
 * reuse the exact same per-hour logic as the single-station forecast below.
 */
function forecastHour(profile, overallAvailablePct, at, tz) {
  const { weekday, hour } = isoWeekdayAndHour(at, tz);
  const cell = profile.get(`${weekday}-${hour}`);
  return {
    at,
    weekday,
    hour,
    availablePct: cell ? cell.availablePct : overallAvailablePct,
    samples: cell ? cell.samples : 0,
    basis: cell ? 'history' : overallAvailablePct !== null ? 'overall-average' : 'no-data',
  };
}

/**
 * How long the station has been continuously in its latest-known status,
 * walked backwards from the most recent snapshot. Capped to the last 500
 * snapshots for a station that has been stable for a very long time - the
 * "since" timestamp in that case is a lower bound, not exact.
 *
 * Deliberately still each snapshot's one blanket overall `status`, not
 * CORE_FUEL_TYPES - same reasoning as metricsService.js leaving outage
 * duration alone: "how long has this station been down" is a discrete
 * streak with no settled per-fuel-type definition yet.
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

// Most recent outages shown on a station card - a handful is plenty to spot
// a pattern (e.g. "always ~2h") without the list itself becoming the thing
// that needs scrolling.
const RECENT_OUTAGES_LIMIT = 10;

// How far back the per-station trend regression looks - short and fixed
// (not lookbackDays-scaled) on purpose: this is meant to answer "is this
// specific station's own availability trending up or down *lately*", the
// same question the region-wide trend forecast answers region-wide, not a
// long-run average.
const STATION_TREND_LOOKBACK_HOURS = 48;
// Below this many hourly buckets with real data, a regression line is more
// noise than signal (2 points always "fit" perfectly and mean nothing) -
// same threshold getRegionTrendForecast already uses for its own buckets.
const MIN_TREND_BUCKETS = 3;

/**
 * Forecasts, for the next `hoursAhead` hours, the station's estimated
 * availability - a linear extrapolation of this station's own last
 * STATION_TREND_LOOKBACK_HOURS (hourly buckets, same
 * CORE_FUEL_TYPES/getAvailabilityTrend machinery as the region-wide trend
 * chart, just scoped to one station via metricsService.getStationTrend),
 * clamped to a valid percentage range. Falls back to a flat average over
 * that same window when there isn't enough of it yet for a meaningful
 * slope (see MIN_TREND_BUCKETS). If the station is currently down, also
 * estimates a recovery time from its historical average outage duration
 * (a separate, longer-lookback signal - see getStationRecoveryStats below).
 *
 * Replaces an earlier version of this function built on a (weekday, hour)
 * seasonal profile (still used by telegramPredictiveAlerts.js's bulk scan -
 * see getBulkHourlyProfiles's own doc comment). Verified live that model
 * was producing a flat line across all 24 forecasted hours for every
 * station checked: with data collection only ~6 days old at the time, most
 * of the next 24 hours' (weekday, hour) combinations - e.g. "Monday
 * 10:00-14:00" when today's Monday hadn't reached 10:00 yet in any prior
 * week - simply had zero historical observations, so every hour fell back
 * to the same flat station-wide average. That cold-start problem will
 * shrink as more weeks of data accumulate, but the deeper issue doesn't:
 * this app is currently tracking a supply-side shortage, not a
 * commute-driven demand pattern, so day-of-week/hour-of-day was never
 * likely to be the right signal for "will this fuel be here soon" in the
 * first place - a short recent trend is.
 *
 * Still a simple empirical estimate, not a fitted time-series model - no
 * seasonality, no confidence interval, same caveat the region-wide trend
 * forecast's own doc comment states.
 */
async function getStationForecastUncached(stationId, { hoursAhead = 24, lookbackDays = 28, tz = DEFAULT_TZ } = {}) {
  const now = new Date();
  const trendFrom = new Date(now.getTime() - STATION_TREND_LOOKBACK_HOURS * 60 * 60 * 1000);

  const [trendBuckets, streak, recoveryStats] = await Promise.all([
    getStationTrend(stationId, { from: trendFrom, to: now, bucketHours: 1, tz }),
    getCurrentStatusStreak(stationId),
    // Previously only fetched when the station was currently down (all
    // this ever needed was avgOutageMinutes for the recovery estimate
    // below) - now always, since the station card's recent-outages list
    // wants this station's outage history regardless of whether it
    // happens to be down at load time.
    getStationRecoveryStats(stationId, { lookbackDays }),
  ]);

  const known = trendBuckets.filter((b) => b.availablePct !== null);
  const reg = known.length >= MIN_TREND_BUCKETS ? linearRegression(known.map((b, i) => ({ x: i, y: b.availablePct }))) : null;
  const overallAvailablePct = known.length ? known.reduce((sum, b) => sum + b.availablePct, 0) / known.length : null;

  const hours = [];
  for (let i = 1; i <= hoursAhead; i++) {
    const at = new Date(now.getTime() + i * 60 * 60 * 1000);
    if (reg) {
      const x = known.length - 1 + i;
      const yRaw = reg.slope * x + reg.intercept;
      hours.push({ at, availablePct: Math.max(0, Math.min(100, yRaw)), samples: known.length, basis: 'trend' });
    } else {
      hours.push({
        at,
        availablePct: overallAvailablePct,
        samples: known.length,
        basis: overallAvailablePct !== null ? 'flat-average' : 'no-data',
      });
    }
  }

  let estimatedRecoveryAt = null;
  if (streak && streak.status === 'not_available' && recoveryStats.avgOutageMinutes !== null) {
    estimatedRecoveryAt = new Date(streak.since.getTime() + recoveryStats.avgOutageMinutes * 60000);
  }

  return {
    currentStatus: streak?.status ?? null,
    currentStatusSince: streak?.since ?? null,
    estimatedRecoveryAt,
    overallAvailablePct,
    hours,
    outageCount: recoveryStats.outageCount,
    avgOutageMinutes: recoveryStats.avgOutageMinutes,
    // Most recent first - a station card cares about "what's it been doing
    // lately", not chronological reading order.
    recentOutages: recoveryStats.outages.slice(-RECENT_OUTAGES_LIMIT).reverse(),
  };
}

// StationDetailModal.vue opens this for every station any visitor clicks -
// walks up to 500 snapshots (getCurrentStatusStreak) plus a 48h trend
// aggregation (getStationTrend) on every call, uncached until now. Same 5
// min TTL as metricsService.js's own memoized functions - the
// `currentStatus`/`estimatedRecoveryAt` fields can lag a real recovery by up
// to that long, but the station's actual live status is shown elsewhere in
// the same modal straight from the (uncached) Station document, so this is
// bounded, cosmetic staleness on a supplementary forecast, not the primary
// status a visitor sees.
const getStationForecast = memoizeAsync(getStationForecastUncached, {
  ttlMs: METRICS_CACHE_TTL_MS,
  keyFn: (stationId, opts = {}) =>
    JSON.stringify([String(stationId), opts.hoursAhead ?? 24, opts.lookbackDays ?? 28, opts.tz ?? DEFAULT_TZ]),
});

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
  getBulkHourlyProfiles,
  getCurrentStatusStreak,
  getStationRecoveryStats,
  forecastHour,
  linearRegression,
  isoWeekdayAndHour,
};
