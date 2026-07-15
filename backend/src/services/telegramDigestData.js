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

  // Caps the requested bucket count to how many real poll ticks the region
  // can actually produce within the span - the hourly digest asks for 12
  // buckets (5 min each) regardless of region, but a region polling every
  // 15 min (the common case) only ever lands a snapshot in 1 of every 3 of
  // those, so most buckets came back empty (drawn as gaps, or - if a poll
  // happened to land awkwardly relative to the bucket boundaries - no line
  // at all). Sizing buckets to the region's own cadence instead means every
  // bucket has a real chance of containing a poll.
  const idealBucketCount = Math.max(1, Math.floor(spanMs / (region.pollIntervalMinutes * 60 * 1000)));
  const bucketCount = Math.min(sparklineBuckets, idealBucketCount);

  const [current, periodStations, prevPeriodStations, series] = await Promise.all([
    metricsService.getCurrentSnapshot(region._id, to),
    metricsService.getStationMetrics(region._id, { from, to }),
    metricsService.getStationMetrics(region._id, { from: prevFrom, to: from }),
    metricsService.getAvailabilitySeries(region._id, { from, to, bucketCount }),
  ]);

  // Pools each station's own reading for metricsService.CORE_FUEL_TYPES
  // (92/95), same as MapView.vue's badge and every other metric in this
  // digest (periodPct/prevPeriodPct/series below all come from
  // metricsService functions that already pool this way) - not each
  // station's one blanket overall status, which read materially more
  // optimistic (see metricsService.js's own doc comment on why). Used only
  // for currentPct below, kept consistent with the live map's own badge %
  // - the human-readable stationCounts breakdown further down is a
  // separate, per-station tally (see its own comment for why).
  const counts = { available: 0, maybe_available: 0, not_available: 0, no_data: 0 };
  for (const s of current) {
    const byType = Object.fromEntries((s.fuelStatuses || []).map((f) => [f.fuelType, f.status]));
    for (const type of metricsService.CORE_FUEL_TYPES) {
      const st = byType[type] || 'no_data';
      counts[st] = (counts[st] || 0) + 1;
    }
  }
  const known = counts.available + counts.maybe_available + counts.not_available;
  // Same MAYBE_AVAILABLE_WEIGHT every other single-number "доступность"
  // figure in the app uses now (see metricsService.js's own doc comment) -
  // this one is cross-sectional (many stations at one instant, not one
  // station's history), so it doesn't need scoreAvailability's shrinkage,
  // just the same weight for consistency with the reports page/live map.
  const currentPct =
    known > 0
      ? ((counts.available + metricsService.MAYBE_AVAILABLE_WEIGHT * counts.maybe_available) / known) * 100
      : null;

  // One status per station (best-of among 92/95, via the same
  // deriveCoreStatus used for the map marker dot, predictive alerts and the
  // disagree-warning) - unlike `counts` above, this sums to exactly
  // stationCount, matching what the digest image's stat chips ("доступно"/
  // "частично"/"нет"/"нет данных") read as to a viewer. Reported by the
  // user: a region's card showed e.g. 15+31+120+36=202 next to a station
  // count well under that, because the old code (still used for `counts`
  // above) counted every station twice - once per core fuel type.
  const stationCounts = { available: 0, maybe_available: 0, not_available: 0, no_data: 0 };
  for (const s of current) {
    const st = metricsService.deriveCoreStatus(s.fuelStatuses);
    stationCounts[st] = (stationCounts[st] || 0) + 1;
  }

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
    stationCounts,
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
