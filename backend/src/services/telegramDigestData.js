const metricsService = require('./metricsService');

const TOP_AVAILABLE_LIMIT = 3;

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

// The most reliable stations over the period (highest availability share),
// with their address - a "here's where fuel is reliably there" highlight,
// rather than dwelling on what's currently broken.
function topAvailableStations(periodStations) {
  return periodStations
    .filter((s) => s.availablePct !== null)
    .sort((a, b) => b.availablePct - a.availablePct)
    .slice(0, TOP_AVAILABLE_LIMIT)
    .map((s) => ({ name: s.name, address: s.address, availablePct: s.availablePct }));
}

/**
 * Everything needed to render one region's digest card + text section:
 * current status breakdown, current/period/previous-period availability,
 * a trend direction, outage count, a sparkline series, and the most
 * reliable stations in the period. `spanMs` is the digest period's length
 * (1h for hourly, 24h for daily) - the previous-period comparison uses the
 * same length window immediately before `from`.
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
    topAvailableStations: topAvailableStations(periodStations),
    stationCount: current.length,
  };
}

module.exports = { buildRegionDigestData };
