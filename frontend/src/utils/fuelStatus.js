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
