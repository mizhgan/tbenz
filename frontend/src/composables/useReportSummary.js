import { computed } from 'vue';
import { formatMinutes, formatPct } from '../utils/colorScale';

// Shared by summary/previousSummary below so the two can't quietly drift
// apart on how they weight/aggregate - previousSummary exists purely to
// diff against, so it has to be computed exactly the same way.
function summarize(stationList) {
  let weightedAvailable = 0;
  let weightForAvailable = 0;
  let weightedRecovery = 0;
  let outagesForRecovery = 0;
  let totalOutages = 0;

  for (const s of stationList) {
    if (s.availablePct !== null) {
      weightedAvailable += s.availablePct * s.totalPolls;
      weightForAvailable += s.totalPolls;
    }
    totalOutages += s.outageCount;
    if (s.avgOutageMinutes !== null) {
      weightedRecovery += s.avgOutageMinutes * s.outageCount;
      outagesForRecovery += s.outageCount;
    }
  }

  return {
    stationCount: stationList.length,
    overallAvailablePct: weightForAvailable > 0 ? weightedAvailable / weightForAvailable : null,
    totalOutages,
    avgRecoveryMinutes: outagesForRecovery > 0 ? weightedRecovery / outagesForRecovery : null,
  };
}

// formatPct/formatMinutes both size their unit to the *magnitude* of the
// number (60+ minutes becomes "X.X ч", not "60+ мин") - correct for a plain
// reading, but applied directly to a *signed* delta it breaks for a
// negative-but-large one (formatMinutes(-130) reads "minutes < 60" as true
// and prints "-130 мин" instead of "-2.2 ч"). Formatting the magnitude and
// prepending the sign here keeps the same unit-scaling these deltas'
// non-delta siblings already use.
function formatSignedPct(delta) {
  const sign = delta > 0 ? '+' : delta < 0 ? '-' : '';
  return `${sign}${formatPct(Math.abs(delta))}`;
}
function formatSignedMinutes(delta) {
  const sign = delta > 0 ? '+' : delta < 0 ? '-' : '';
  return `${sign}${formatMinutes(Math.abs(delta))}`;
}
function formatSignedCount(delta) {
  return delta > 0 ? `+${delta}` : `${delta}`;
}

/**
 * The KPI cards' own weighted-average summary for the selected period, plus
 * the same summary for the immediately-preceding period (useReportMetrics.js's
 * own previousStations) so each card can show a "+3% vs previous period"
 * delta instead of a bare number with no sense of whether that's an
 * improvement.
 */
export function useReportSummary({ stations, previousStations }) {
  const summary = computed(() => summarize(stations.value));
  // Only ever read for the KPI cards' own delta line below - not otherwise
  // exposed (no "previous period" table/section of its own).
  const previousSummary = computed(() => summarize(previousStations.value));

  // null when either side has no comparable data (a period with zero known
  // polls, or the previous period predating the region's own history) - the
  // KPI card simply omits its delta line in that case rather than showing a
  // misleading comparison against nothing.
  const availabilityDelta = computed(() => {
    if (summary.value.overallAvailablePct === null || previousSummary.value.overallAvailablePct === null) return null;
    return summary.value.overallAvailablePct - previousSummary.value.overallAvailablePct;
  });
  const outagesDelta = computed(() => {
    if (!previousStations.value.length) return null;
    return summary.value.totalOutages - previousSummary.value.totalOutages;
  });
  const recoveryDelta = computed(() => {
    if (summary.value.avgRecoveryMinutes === null || previousSummary.value.avgRecoveryMinutes === null) return null;
    return summary.value.avgRecoveryMinutes - previousSummary.value.avgRecoveryMinutes;
  });

  return {
    summary,
    previousSummary,
    availabilityDelta,
    outagesDelta,
    recoveryDelta,
    formatSignedPct,
    formatSignedMinutes,
    formatSignedCount,
  };
}
