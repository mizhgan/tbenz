const Station = require('../models/Station');
const StationSnapshot = require('../models/StationSnapshot');
const metricsService = require('./metricsService');

const AVAILABLE_LIKE = new Set(['available', 'maybe_available']);
const PROBLEM_STATION_LIMIT = 3;
const PROBLEM_LOOKBACK_MS = 3 * 24 * 3600 * 1000;

function weightedAvgAvailablePct(stationMetrics) {
  let sumPct = 0;
  let sumWeight = 0;
  for (const s of stationMetrics) {
    if (s.availablePct !== null) {
      sumPct += s.availablePct * s.totalPolls;
      sumWeight += s.totalPolls;
    }
  }
  return sumWeight > 0 ? sumPct / sumWeight : null;
}

// How long each currently-not_available station has (probably) been down:
// walks each station's own history backwards from `to`, extending the
// "down since" timestamp through every not_available/no_data reading (no_data
// is ambiguous - could still be the same outage, see computeOutages) until
// hitting an available/maybe_available reading. If the outage started before
// the lookback window, this underestimates its true duration - same
// "censored data" honesty as computeOutages elsewhere in this codebase.
async function buildProblemStations(regionId, downStationIds, to) {
  if (!downStationIds.length) return [];

  const lookbackFrom = new Date(to.getTime() - PROBLEM_LOOKBACK_MS);
  const rows = await StationSnapshot.find(
    { region: regionId, station: { $in: downStationIds }, polledAt: { $gte: lookbackFrom, $lte: to } },
    { station: 1, polledAt: 1, status: 1 }
  )
    .sort({ station: 1, polledAt: -1 })
    .lean();

  const historyByStation = new Map();
  for (const row of rows) {
    const key = String(row.station);
    if (!historyByStation.has(key)) historyByStation.set(key, []);
    historyByStation.get(key).push(row);
  }

  const downSinceByStation = new Map();
  for (const [key, history] of historyByStation) {
    let since = history[0]?.polledAt ?? to;
    for (const snap of history) {
      if (AVAILABLE_LIKE.has(snap.status)) break;
      since = snap.polledAt;
    }
    downSinceByStation.set(key, since);
  }

  const stationDocs = await Station.find(
    { _id: { $in: downStationIds } },
    { name: 1, address: 1 }
  ).lean();

  return stationDocs
    .map((s) => {
      const since = downSinceByStation.get(String(s._id)) ?? to;
      return { station: s, downSinceMs: to.getTime() - since.getTime() };
    })
    .sort((a, b) => b.downSinceMs - a.downSinceMs)
    .slice(0, PROBLEM_STATION_LIMIT);
}

/**
 * Everything needed to render one region's digest card + text section:
 * current status breakdown, current/period/previous-period availability,
 * a trend direction, outage count, a sparkline series, and the worst
 * currently-down stations. `spanMs` is the digest period's length (1h for
 * hourly, 24h for daily) - the previous-period comparison uses the same
 * length window immediately before `from`.
 */
async function buildRegionDigestData(region, { from, to, spanMs, sparklineBuckets = 12 }) {
  const prevFrom = new Date(from.getTime() - spanMs);

  const [current, periodStations, prevPeriodStations, series] = await Promise.all([
    metricsService.getCurrentSnapshot(region._id, to),
    metricsService.getStationMetrics(region._id, { from, to }),
    metricsService.getStationMetrics(region._id, { from: prevFrom, to: from }),
    metricsService.getAvailabilitySeries(region._id, { from, to, bucketCount: sparklineBuckets }),
  ]);

  const counts = { available: 0, maybe_available: 0, not_available: 0, no_data: 0 };
  for (const s of current) counts[s.status] = (counts[s.status] || 0) + 1;
  const known = counts.available + counts.maybe_available + counts.not_available;
  const currentPct = known > 0 ? ((counts.available + counts.maybe_available) / known) * 100 : null;

  const periodPct = weightedAvgAvailablePct(periodStations);
  const prevPeriodPct = weightedAvgAvailablePct(prevPeriodStations);

  let trend = 'unknown';
  let trendDeltaPct = null;
  if (periodPct !== null && prevPeriodPct !== null) {
    trendDeltaPct = periodPct - prevPeriodPct;
    if (trendDeltaPct > 1) trend = 'improving';
    else if (trendDeltaPct < -1) trend = 'worsening';
    else trend = 'stable';
  }

  const totalOutages = periodStations.reduce((sum, s) => sum + s.outageCount, 0);

  const downStationIds = current.filter((s) => s.status === 'not_available').map((s) => s.stationId);
  const problemStations = await buildProblemStations(region._id, downStationIds, to);

  return {
    region,
    from,
    to,
    counts,
    currentPct,
    periodPct,
    prevPeriodPct,
    trend,
    trendDeltaPct,
    totalOutages,
    series,
    problemStations,
    stationCount: current.length,
  };
}

module.exports = { buildRegionDigestData };
