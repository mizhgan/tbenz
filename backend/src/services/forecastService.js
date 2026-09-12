const StationSnapshot = require('../models/StationSnapshot');
const Station = require('../models/Station');
const {
  computeOutages,
  getAvailabilityTrend,
  getStationTrend,
  CORE_FUEL_TYPES,
  METRICS_CACHE_TTL_MS,
  deriveCoreStatus,
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
 * Per-station availability share for each hour-of-day (0-23), pooled across
 * every weekday - the day/night-cycle baseline getStationForecastUncached
 * blends its own short-trend extrapolation into for hours further out (see
 * that function's doc comment and blendHourForecast below). Deliberately
 * NOT split by weekday like getBulkHourlyProfiles' own (weekday, hour)
 * grid: with only a few days to a few weeks of history, a 168-cell grid
 * mostly lands under MIN_HOUR_PROFILE_SAMPLES per cell - the same
 * cold-start problem that retired the old seasonal per-station forecast.
 * Pooling by hour alone needs 7x fewer samples per cell to become
 * informative, trading away a "Monday morning vs Saturday morning"
 * distinction a supply-driven shortage is unlikely to care about anyway.
 * Confirmed live across a 15-station sample: a clear day/night cycle
 * (long overnight outages, available during the day) showed up in 5 of 15
 * stations checked - common enough to be worth a dedicated signal, not a
 * one-off.
 */
async function getStationHourProfile(stationId, { lookbackDays = 28, tz = DEFAULT_TZ } = {}) {
  const from = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const rows = await StationSnapshot.aggregate([
    { $match: { station: stationId, polledAt: { $gte: from } } },
    { $addFields: { hour: { $hour: { date: '$polledAt', timezone: tz } } } },
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
        _id: '$hour',
        total: { $sum: 1 },
        available: { $sum: { $cond: [{ $eq: ['$coreFuelStatuses.status', 'available'] }, 1, 0] } },
        noData: { $sum: { $cond: [{ $eq: ['$coreFuelStatuses.status', 'no_data'] }, 1, 0] } },
      },
    },
  ]);

  const profile = new Map();
  for (const row of rows) {
    const known = row.total - row.noData;
    if (known > 0) {
      profile.set(row._id, { availablePct: (row.available / known) * 100, samples: known });
    }
  }
  return profile;
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

// The regression that actually drives the near-term forecast (see
// blendHourForecast below) fits over just this many of the most recent
// hourly buckets, not the full STATION_TREND_LOOKBACK_HOURS window (that
// window is still fetched and kept around for overallAvailablePct's own
// longer-run baseline). A station that just recovered after a long outage
// - confirmed live for a real station (Лукойл, Потребкооперации 2/1):
// available for the last ~4h after a ~13h outage - had its forecast stuck
// near 15% for the next 12 hours, because an unweighted regression over the
// full 48h gave equal say to those 13 down-hours and the 4 up-hours,
// netting out to a nearly flat line. An 8h window is short enough that a
// real recent change dominates the fit instead of being diluted by it.
const SHORT_TREND_LOOKBACK_HOURS = 8;

// Below this many real observations, an hour-of-day profile cell (see
// getStationHourProfile) is too thin to trust over the plain overall
// average - same reasoning as MIN_TREND_BUCKETS above, just for a
// different signal.
const MIN_HOUR_PROFILE_SAMPLES = 3;

// How many forecasted hours the short-trend regression's own extrapolation
// fades into the hour-of-day profile over, rather than a hard cutover at a
// fixed hour - a straight line extrapolated many hours past its own 8h
// input window stops being meaningful (it doesn't know a supply-driven
// station's actual day/night cycle), but switching models outright would
// show a visible "cliff" in the hourly bar chart between two models'
// different answers for the same hour.
const TREND_BLEND_HOURS = 3;

// The forecast's actual starting point - the station's literally-just-
// observed core-fuel status, mapped the same "available + maybe_available
// both count as available" way every other %-availability number in the
// app already does (see metricsService.js's withKnownPct) rather than a
// 50%-partial-credit guess for maybe_available. Only no_data has nothing
// to anchor to.
function currentCoreStatusToPct(status) {
  if (status === 'available' || status === 'maybe_available') return 100;
  if (status === 'not_available') return 0;
  return null;
}

/**
 * One forecasted hour's availability, blending three inputs:
 *  - `currentAnchorPct` (see currentCoreStatusToPct above): guarantees the
 *    forecast starts from the truth, not from wherever a regression line
 *    happens to sit.
 *  - `shortReg.slope`: rate of change per hour from a linear fit over the
 *    station's own last SHORT_TREND_LOOKBACK_HOURS - used ONLY for its
 *    slope, projected forward from currentAnchorPct rather than trusting
 *    the regression's own fitted value at hour i directly. An earlier
 *    version of this function used that raw fitted value unanchored, and
 *    was found - via a fair same-instant comparison against the previous
 *    48h-window model, on the same 15 stations already sampled to justify
 *    adding this short window in the first place - to actually mismatch
 *    *more* often (6/8 vs 4/8 currently-up stations forecasting <40% for
 *    the next hour), not less. Root cause: a short window is more reactive
 *    to a couple of noisy/borderline hours (e.g. a station that had been
 *    100% for a day and just dipped to a weak maybe_available in the last
 *    hour) - without an anchor, that reactivity showed up as the fitted
 *    line simply being wrong about *right now*, not just aggressive about
 *    the future. Anchoring fixes that: hour 1 is always close to the truth,
 *    and the slope only shapes the trajectory away from it.
 *  - `hourProfile`: this station's historical availability share for this
 *    specific hour-of-day (see getStationHourProfile) - takes over for
 *    hours further out a short window's slope can't meaningfully reach,
 *    same as before.
 * The trend (anchored) and profile signals are linearly blended over
 * TREND_BLEND_HOURS forecasted hours so the hourly bar chart doesn't show
 * a visible cliff where the model handoff happens.
 */
function blendHourForecast({ i, currentAnchorPct, shortReg, hourProfile, overallAvailablePct, at, tz }) {
  let trendPct = null;
  let trendBasis = null;
  if (currentAnchorPct !== null) {
    const slope = shortReg ? shortReg.slope : 0;
    trendPct = Math.max(0, Math.min(100, currentAnchorPct + slope * i));
    trendBasis = shortReg ? 'trend' : 'current';
  }

  const { hour } = isoWeekdayAndHour(at, tz);
  const cell = hourProfile.get(hour);
  const hasProfileCell = Boolean(cell) && cell.samples >= MIN_HOUR_PROFILE_SAMPLES;
  const profilePct = hasProfileCell ? cell.availablePct : overallAvailablePct;
  const profileBasis = hasProfileCell ? 'hour-profile' : profilePct !== null ? 'flat-average' : 'no-data';

  if (trendPct === null) {
    return { availablePct: profilePct, basis: profilePct !== null ? profileBasis : 'no-data' };
  }
  if (profilePct === null) {
    return { availablePct: trendPct, basis: trendBasis };
  }

  const blendWeight = Math.max(0, Math.min(1, 1 - (i - 1) / TREND_BLEND_HOURS));
  if (blendWeight >= 1) return { availablePct: trendPct, basis: trendBasis };
  if (blendWeight <= 0) return { availablePct: profilePct, basis: profileBasis };
  return {
    availablePct: trendPct * blendWeight + profilePct * (1 - blendWeight),
    basis: `${trendBasis}+hour-profile`,
  };
}

/**
 * Forecasts, for the next `hoursAhead` hours, the station's estimated
 * availability by blending a short-term trend with an hour-of-day baseline
 * (see blendHourForecast above for how and why). If the station is
 * currently down, also estimates a recovery time from its historical
 * average outage duration (a separate, longer-lookback signal - see
 * getStationRecoveryStats below).
 *
 * Replaces an earlier version of this function built on a (weekday, hour)
 * seasonal profile (still used by telegramPredictiveAlerts.js's bulk scan -
 * see getBulkHourlyProfiles's own doc comment) - that one was retired for
 * being flat across all 24 hours for every station checked (cold-start: no
 * (weekday, hour) history yet for most of the next day's slots). The
 * trend-only model that replaced it had its own failure mode, also found
 * live: a station that just recovered after a long outage (Лукойл,
 * Потребкооперации 2/1 - available for ~4h after a ~13h outage) stayed
 * forecast near 15% for the next 12 hours, because its regression pooled
 * the full 48h unweighted, diluting the recent recovery under a longer
 * down streak. This version fixes that with a short (8h) trend window for
 * the near term, and - since a same-15-station sample found a real
 * day/night availability cycle in 5 of them - adds the hour-of-day profile
 * back for the hours further out the short trend can't meaningfully reach,
 * without reintroducing the (weekday, hour) grid's cold-start problem
 * (hour-only needs 7x fewer samples per cell to be trusted).
 *
 * Still a simple empirical estimate, not a fitted time-series model - no
 * seasonality confidence interval, same caveat the region-wide trend
 * forecast's own doc comment states.
 */
async function getStationForecastUncached(stationId, { hoursAhead = 24, lookbackDays = 28, tz = DEFAULT_TZ } = {}) {
  const now = new Date();
  const trendFrom = new Date(now.getTime() - STATION_TREND_LOOKBACK_HOURS * 60 * 60 * 1000);
  const shortTrendFrom = new Date(now.getTime() - SHORT_TREND_LOOKBACK_HOURS * 60 * 60 * 1000);

  const [trendBuckets, streak, recoveryStats, hourProfile, station] = await Promise.all([
    getStationTrend(stationId, { from: trendFrom, to: now, bucketHours: 1, tz }),
    getCurrentStatusStreak(stationId),
    // Previously only fetched when the station was currently down (all
    // this ever needed was avgOutageMinutes for the recovery estimate
    // below) - now always, since the station card's recent-outages list
    // wants this station's outage history regardless of whether it
    // happens to be down at load time.
    getStationRecoveryStats(stationId, { lookbackDays }),
    getStationHourProfile(stationId, { lookbackDays, tz }),
    // The Station document's own lastFuelStatuses (not a StationSnapshot
    // query) - the same field the map marker/badge already treat as "the"
    // current reading, kept fresh on every ingest tick regardless of
    // polling cadence. Used only for currentCoreStatusToPct's anchor below.
    Station.findById(stationId, { lastFuelStatuses: 1 }).lean(),
  ]);

  const known = trendBuckets.filter((b) => b.availablePct !== null);
  const overallAvailablePct = known.length ? known.reduce((sum, b) => sum + b.availablePct, 0) / known.length : null;

  // Short window is a time-based slice of the already-fetched 48h buckets
  // (no extra query) - same filter-then-index convention `known` above
  // uses, so a gap in the short window compacts rather than leaving a null
  // point for linearRegression to skip over anyway.
  const shortKnown = trendBuckets.filter((b) => b.bucketStart >= shortTrendFrom && b.availablePct !== null);
  const shortReg =
    shortKnown.length >= MIN_TREND_BUCKETS
      ? linearRegression(shortKnown.map((b, i) => ({ x: i, y: b.availablePct })))
      : null;
  const currentAnchorPct = currentCoreStatusToPct(deriveCoreStatus(station?.lastFuelStatuses));

  const hours = [];
  for (let i = 1; i <= hoursAhead; i++) {
    const at = new Date(now.getTime() + i * 60 * 60 * 1000);
    const { availablePct, basis } = blendHourForecast({
      i,
      currentAnchorPct,
      shortReg,
      hourProfile,
      overallAvailablePct,
      at,
      tz,
    });
    hours.push({ at, availablePct, samples: shortKnown.length, basis });
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

// A fixed forecast horizon (the old default was a flat 6 buckets regardless
// of period length) reads fine on a long report - 6 of 90 daily buckets is a
// small tail - but on the page's own default 7-day period, 6 of 13 buckets
// is nearly half the chart's width, drowning out the actual history it's
// supposed to extrapolate from. Scaling the horizon to a fraction of however
// much history is actually on screen keeps the forecast a tail at any period
// length; MIN keeps a short period from collapsing to a single forecast
// point, MAX keeps the old 6-bucket cap for long periods where the fraction
// alone would otherwise keep growing.
const AUTO_BUCKETS_AHEAD_FRACTION = 0.2;
const AUTO_BUCKETS_AHEAD_MIN = 2;
const AUTO_BUCKETS_AHEAD_MAX = 6;

// Pulled out as its own pure function (rather than inlined) so it's unit-
// testable without a DB-backed getAvailabilityTrend call, same reasoning as
// linearRegression/blendHourForecast below.
function resolveBucketsAhead(explicitBucketsAhead, historyLength) {
  if (explicitBucketsAhead !== undefined && explicitBucketsAhead !== null) return explicitBucketsAhead;
  return Math.min(AUTO_BUCKETS_AHEAD_MAX, Math.max(AUTO_BUCKETS_AHEAD_MIN, Math.ceil(historyLength * AUTO_BUCKETS_AHEAD_FRACTION)));
}

/**
 * Naive linear extrapolation of the region's recent availability trend -
 * NOT a real time-series model (no seasonality, no confidence interval),
 * just a rough "is it getting better or worse" signal with a projected
 * continuation of the line, clamped to a valid percentage range.
 *
 * `bucketsAhead` is optional - omit it (as the reports page does) to scale
 * the horizon to the period's own history length instead of a fixed count;
 * pass it explicitly to force a specific horizon regardless of period length.
 */
async function getRegionTrendForecast(regionId, { from, to, bucketHours = 24, bucketsAhead, tz } = {}) {
  const buckets = await getAvailabilityTrend(regionId, { from, to, bucketHours, tz });

  if (buckets.length < 3) {
    return { direction: 'unknown', slopePerBucket: null, buckets, forecast: [] };
  }

  const points = buckets.map((b, i) => ({ x: i, y: b.availablePct }));
  const reg = linearRegression(points);
  if (!reg) {
    return { direction: 'unknown', slopePerBucket: null, buckets, forecast: [] };
  }

  const effectiveBucketsAhead = resolveBucketsAhead(bucketsAhead, buckets.length);

  const lastBucketStartMs = buckets[buckets.length - 1].bucketStart.getTime();
  const bucketMs = bucketHours * 60 * 60 * 1000;
  const forecast = [];
  for (let i = 1; i <= effectiveBucketsAhead; i++) {
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
  getStationForecastUncached,
  getRegionTrendForecast,
  getBulkHourlyProfiles,
  getStationHourProfile,
  getCurrentStatusStreak,
  getStationRecoveryStats,
  forecastHour,
  blendHourForecast,
  currentCoreStatusToPct,
  linearRegression,
  isoWeekdayAndHour,
  resolveBucketsAhead,
};
