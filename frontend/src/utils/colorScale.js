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

export function formatMinutes(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return '—';
  if (minutes < 60) return `${Math.round(minutes)} мин`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)} ч`;
  return `${(hours / 24).toFixed(1)} дн`;
}
