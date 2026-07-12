// The source reports fuel *availability* inferred from recent card
// transactions, not prices or stock levels. Order below is a display-only
// heuristic (worst -> best confidence that fuel is available) used to lay
// statuses out on a chart axis; it isn't an officially documented ordering.
export const STATUS_ORDER = ['not_available', 'no_data', 'maybe_available', 'available'];

export const STATUS_META = {
  available: { label: 'Есть', color: '#16a34a' },
  maybe_available: { label: 'Возможно есть', color: '#d97706' },
  not_available: { label: 'Нет', color: '#dc2626' },
  no_data: { label: 'Нет данных', color: '#9ca3af' },
};

export function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.no_data;
}

export function statusOrdinal(status) {
  const idx = STATUS_ORDER.indexOf(status);
  return idx === -1 ? STATUS_ORDER.indexOf('no_data') : idx;
}

// Short "how long ago" label for a per-fuel-type reading's own
// lastTransactionAt (see useSourceFuelRows.js) - a source like alfabank can
// go days between transactions for a given fuel type, so "when" is exactly
// the context that explains why a reading is available/maybe/no_data rather
// than being a mystery number. Deliberately coarser than formatMinutes
// (colorScale.js, built for outage durations of at most a few days) - ages
// here comfortably span weeks.
export function formatRelativeAge(dateLike) {
  if (!dateLike) return null;
  const date = new Date(dateLike);
  const ms = Date.now() - date.getTime();
  if (Number.isNaN(ms)) return null;
  if (ms < 0) return 'только что';
  const minutes = ms / 60000;
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${Math.round(minutes)} мин назад`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)} ч назад`;
  const days = hours / 24;
  if (days < 60) return `${Math.round(days)} дн назад`;
  return date.toLocaleDateString('ru-RU');
}

// Fuel types are raw strings from the source ("92", "95", "98", ...);
// octane ratings read better prefixed with "АИ-", but a non-numeric type
// (e.g. diesel, however the source ends up encoding it) is shown as-is.
export function fuelTypeLabel(type) {
  return /^\d+$/.test(type) ? `АИ-${type}` : type;
}

// Numeric fuel types (octane ratings) sort by value; non-numeric ones (e.g.
// diesel) sort alphabetically after all numeric ones.
export function sortFuelTypes(types) {
  return [...types].sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    const aIsNum = !Number.isNaN(na);
    const bIsNum = !Number.isNaN(nb);
    if (aIsNum && bIsNum) return na - nb;
    if (aIsNum) return -1;
    if (bIsNum) return 1;
    return a.localeCompare(b, 'ru');
  });
}
