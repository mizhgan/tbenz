// Red (0%) -> yellow (50%) -> green (100%) availability color scale, used by
// the heatmap grid and reliability table. Neutral gray stands in for
// "no data" so it doesn't get misread as "0% available".
export function availabilityColor(pct) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return '#e5e7eb';
  const clamped = Math.max(0, Math.min(100, pct));
  const hue = (clamped / 100) * 120;
  return `hsl(${hue}, 70%, 45%)`;
}

export function formatPct(pct, fractionDigits = 0) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return '—';
  return `${pct.toFixed(fractionDigits)}%`;
}

// Shared by ReportsView.vue's recovery-trend hint text and
// AvailabilityRecoveryChart.vue's own tooltip - both used to hardcode "за
// день" regardless of the period's actual bucket size, which reads as a bug
// once a period wide enough to fall into weekly buckets, not daily, is
// selected (a bar's tooltip claiming "N отключений за день" when it's
// really a week's worth). One function so the two spots can't drift apart
// on the same threshold again.
export function bucketPeriodLabel(bucketHours) {
  if (bucketHours >= 24 * 7) return 'за неделю';
  if (bucketHours >= 24) return 'за день';
  return 'за бакет';
}

export function formatMinutes(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return '—';
  if (minutes < 60) return `${Math.round(minutes)} мин`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)} ч`;
  return `${(hours / 24).toFixed(1)} дн`;
}
