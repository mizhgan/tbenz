const Station = require('../models/Station');
const metricsService = require('./metricsService');
const forecastService = require('./forecastService');

const DEFAULT_TZ = 'Europe/Moscow';
const LOOKBACK_DAYS = 28;
const DROP_THRESHOLD_PCT = 30;
const DROP_HOURS_AHEAD = 2;
const RECOVERY_WINDOW_MS = 60 * 60 * 1000;
// Once a station has been alerted for a given prediction type, don't
// re-alert it again until this much time has passed - the forecast doesn't
// change meaningfully between scans, so without this the same ongoing
// prediction would fire on every single scan interval.
const COOLDOWN_MS = 3 * 60 * 60 * 1000;

const STATUS_RANK = { not_available: 0, no_data: 1, maybe_available: 2, available: 3 };

// Best-of among the station's own core-3 (92/95/ДТ) readings - "is at least
// one of the fuels a driver actually wants available here right now", same
// framing as MapView.vue's own effectiveStatus (best-of among selected fuel
// types) and the rest of this app's core-fuel-type metrics (see
// metricsService.js's own doc comment on CORE_FUEL_TYPES). Used below to
// decide which bucket (up/down) a station falls into for alerting purposes,
// instead of its blanket overall `status` - a station could be blanket
// "available" purely off a non-core fuel type (propane) or a secondary
// source's own station-level opinion, while having nothing useful to say
// about 92/95/ДТ specifically; alerting off that would be misleading.
function coreStatus(fuelStatuses) {
  const relevant = (fuelStatuses || []).filter((f) => metricsService.CORE_FUEL_TYPES.includes(f.fuelType));
  if (!relevant.length) return 'no_data';
  return relevant.reduce((best, f) => (STATUS_RANK[f.status] > STATUS_RANK[best] ? f.status : best), relevant[0].status);
}

function isCoolingDown(lastAlertAt, now) {
  return Boolean(lastAlertAt) && now.getTime() - new Date(lastAlertAt).getTime() < COOLDOWN_MS;
}

// Currently available/maybe_available (by coreStatus - see above) stations
// whose historical (weekday, hour) profile predicts availability will fall
// below DROP_THRESHOLD_PCT within the next DROP_HOURS_AHEAD hours - a single
// bulk aggregation across every candidate station, not one query each.
async function scanForDrops(upStations, cooldownById, now, tz) {
  if (!upStations.length) return [];

  const stationIds = upStations.map((s) => s.stationId);
  const profiles = await forecastService.getBulkHourlyProfiles(stationIds, { lookbackDays: LOOKBACK_DAYS, tz });

  const alerts = [];
  const qualifyingIds = [];
  for (const s of upStations) {
    const key = String(s.stationId);
    const entry = profiles.get(key);
    if (!entry) continue; // no history yet - nothing to forecast from

    if (isCoolingDown(cooldownById.get(key)?.lastPredictiveDropAlertAt, now)) continue;

    let risky = null;
    for (let i = 1; i <= DROP_HOURS_AHEAD; i++) {
      const at = new Date(now.getTime() + i * 3600000);
      const hour = forecastService.forecastHour(entry.profile, entry.overallAvailablePct, at, tz);
      if (hour.availablePct !== null && hour.availablePct < DROP_THRESHOLD_PCT) {
        risky = hour;
        break;
      }
    }
    if (!risky) continue;

    alerts.push({
      station: { _id: s.stationId, name: s.name, address: s.address },
      predictedAt: risky.at,
      availablePct: risky.availablePct,
    });
    qualifyingIds.push(s.stationId);
  }

  if (qualifyingIds.length) {
    await Station.updateMany({ _id: { $in: qualifyingIds } }, { $set: { lastPredictiveDropAlertAt: now } });
  }
  return alerts;
}

// Currently not_available stations whose average historical outage
// duration suggests they should come back within RECOVERY_WINDOW_MS. Down
// stations are typically a small subset of a region, so a per-station
// query each (same cost as the existing single-station map forecast) is
// affordable here, unlike the drop check above.
async function scanForRecoveries(downStations, cooldownById, now) {
  if (!downStations.length) return [];

  const alerts = [];
  const qualifyingIds = [];
  for (const s of downStations) {
    const key = String(s.stationId);
    if (isCoolingDown(cooldownById.get(key)?.lastPredictiveRecoveryAlertAt, now)) continue;

    const [streak, recoveryStats] = await Promise.all([
      forecastService.getCurrentStatusStreak(s.stationId),
      forecastService.getStationRecoveryStats(s.stationId, { lookbackDays: LOOKBACK_DAYS }),
    ]);
    if (!streak || streak.status !== 'not_available' || recoveryStats.avgOutageMinutes === null) continue;

    const estimatedRecoveryAt = new Date(streak.since.getTime() + recoveryStats.avgOutageMinutes * 60000);
    const msUntilRecovery = estimatedRecoveryAt.getTime() - now.getTime();
    // Only "coming back soon" - not already overdue, not too far out.
    if (msUntilRecovery < 0 || msUntilRecovery > RECOVERY_WINDOW_MS) continue;

    alerts.push({
      station: { _id: s.stationId, name: s.name, address: s.address },
      estimatedRecoveryAt,
    });
    qualifyingIds.push(s.stationId);
  }

  if (qualifyingIds.length) {
    await Station.updateMany({ _id: { $in: qualifyingIds } }, { $set: { lastPredictiveRecoveryAlertAt: now } });
  }
  return alerts;
}

/**
 * Scans every currently-known station in a region for a forecast-based
 * heads-up worth sending before the actual transition happens: "likely to
 * run out soon" (currently up) or "likely back soon" (currently down) -
 * "up"/"down" meaning coreStatus (92/95/ДТ), not the station's blanket
 * overall status. Whole-region, not limited to a watchlist - kept affordable
 * by bulk-aggregating the (typically much larger) up-station set in one
 * query and only doing per-station work for the (typically much smaller)
 * down-station set. Each qualifying station's relevant cooldown timestamp is
 * updated as part of the scan so the same ongoing prediction isn't
 * re-alerted on the next tick.
 */
async function scanRegion(region, { now = new Date(), tz = DEFAULT_TZ } = {}) {
  const current = await metricsService.getCurrentSnapshot(region._id, now);
  if (!current.length) return { dropAlerts: [], recoveryAlerts: [] };

  const cooldownDocs = await Station.find(
    { _id: { $in: current.map((s) => s.stationId) } },
    { lastPredictiveDropAlertAt: 1, lastPredictiveRecoveryAlertAt: 1 }
  ).lean();
  const cooldownById = new Map(cooldownDocs.map((d) => [String(d._id), d]));

  const upStations = current.filter((s) => {
    const st = coreStatus(s.fuelStatuses);
    return st === 'available' || st === 'maybe_available';
  });
  const downStations = current.filter((s) => coreStatus(s.fuelStatuses) === 'not_available');

  const [dropAlerts, recoveryAlerts] = await Promise.all([
    scanForDrops(upStations, cooldownById, now, tz),
    scanForRecoveries(downStations, cooldownById, now),
  ]);

  return { dropAlerts, recoveryAlerts };
}

module.exports = { scanRegion, coreStatus, DROP_THRESHOLD_PCT, DROP_HOURS_AHEAD, RECOVERY_WINDOW_MS, COOLDOWN_MS };
