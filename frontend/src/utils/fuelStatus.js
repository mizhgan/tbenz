// The source reports fuel *availability* inferred from recent card
// transactions, not prices or stock levels. Order below is a display-only
// heuristic (worst -> best confidence that fuel is available) used to lay
// statuses out on a chart axis; it isn't an officially documented ordering.
export const STATUS_ORDER = ['not_available', 'no_data', 'maybe_available', 'available'];

// Gasoline only - mirrors the backend's own CORE_FUEL_TYPES (see
// metricsService.js's doc comment for the real-data justification: gasoline
// availability is meaningfully worse than diesel, so folding diesel in
// dilutes/hides the real shortage). Single source of truth for every
// frontend file that needs "the default fuel types" - map badge/filters,
// station history chart, shareable station card.
export const CORE_FUEL_TYPES = ['92', '95'];

// How much a maybe_available reading counts toward a single "доступность"
// percentage (MapView.vue's live badge) - mirrors the backend's own
// MAYBE_AVAILABLE_WEIGHT (metricsService.js), which every other
// single-number availability figure in the app (reports ranking, heatmap,
// Telegram digest/alerts) now uses. Kept in sync by hand since the frontend
// and backend don't share a module - if this value changes, change
// MAYBE_AVAILABLE_WEIGHT too.
export const MAYBE_AVAILABLE_WEIGHT = 0.7;

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

// Best (see STATUS_ORDER) status among `types` (gasoline/CORE_FUEL_TYPES by
// default) - "is at least one of these available" is the useful question
// for a single status badge, not "are all of them". Mirrors the backend's
// own metricsService.deriveCoreStatus exactly (same rank order, same
// no_data-for-nothing-to-check fallback) - use this instead of a station's
// blanket `status`/`lastStatus` field wherever a badge is meant to say
// "is gasoline here", since that blanket field is its own independent vote
// across every fuel type a station sells (see mergeStatusService.js's own
// doc comment: "overall status is its own value from the source, not
// derived from the per-fuel breakdown") and can disagree with the
// gasoline-only picture - confirmed live: a station showing green on the
// map (gasoline fine) read orange on its own detail card, because the
// card's badge was reading raw `station.status` instead of this.
export function bestFuelStatus(fuelStatuses, types = CORE_FUEL_TYPES) {
  const entries = (fuelStatuses || []).filter((f) => types.includes(f.fuelType));
  if (!entries.length) return 'no_data';
  let best = entries[0].status;
  for (const entry of entries) {
    if (statusOrdinal(entry.status) > statusOrdinal(best)) best = entry.status;
  }
  return best;
}

// Collapses a station's raw snapshot history (oldest -> newest, each with
// its own `fuelStatuses`) into contiguous runs of the same core-fuel status
// - "10 hours available, then 12 hours down" as literal {status, start,
// end} blocks, not a downsampled/bucketed approximation. Verified live this
// is cheap enough to skip bucketing entirely: even the single most
// fragmented station in production over a 7-day window (real ~15-minute
// polling, ~700 raw snapshots) collapses to ~216 segments - trivial to
// render, nowhere near a performance concern.
//
// Each segment's `end` is stretched to the *next* segment's `start` (not
// left at its own last snapshot's time) so the timeline is gapless - a
// status is assumed to hold until the next poll actually contradicts it,
// same assumption metricsService.computeOutages makes on the backend. The
// final segment's `end` is its own last snapshot's time, since there's
// nothing later to stretch to.
export function computeStatusSegments(history, types = CORE_FUEL_TYPES) {
  if (!history?.length) return [];

  const runs = [];
  for (const snap of history) {
    const status = bestFuelStatus(snap.fuelStatuses, types);
    const at = new Date(snap.polledAt);
    const last = runs[runs.length - 1];
    if (last && last.status === status) {
      last.lastSeenAt = at;
      last.sampleCount += 1;
    } else {
      runs.push({ status, start: at, lastSeenAt: at, sampleCount: 1 });
    }
  }

  return runs.map((run, i) => {
    const end = i < runs.length - 1 ? runs[i + 1].start : run.lastSeenAt;
    return {
      status: run.status,
      start: run.start,
      end,
      durationMinutes: (end.getTime() - run.start.getTime()) / 60000,
      // How many raw polls actually landed on this status while this
      // segment was open - see collapseIsolatedBlips below, which uses this
      // (not durationMinutes) to tell a single anomalous poll apart from a
      // real, if brief, change: duration alone can't, since a region's own
      // poll interval isn't fixed/known here, and a single poll can span an
      // arbitrarily long gap to the next one if a poll cycle was missed.
      sampleCount: run.sampleCount,
    };
  });
}

// Merges away a segment backed by exactly one raw poll (sampleCount === 1)
// when the status on both sides of it is identical - confirmed live this is
// a real, common pattern (240 isolated single-poll blips found across a
// 150-station sample over one week, nearly all sandwiched between
// same-status stretches spanning hours), most likely one source's vote in
// the merge briefly landing on a different value for a single tick rather
// than a real change. Deliberately conservative: never merges a segment
// that differs between its two neighbors (available -> maybe_available ->
// ... could be the genuine start of a real transition, not noise to hide)
// or one backed by 2+ consecutive polls (harder to dismiss as a one-off).
// Starting with exactly this narrow a rule on purpose, to see how much of
// the reported "anomaly" pattern it actually accounts for before
// considering anything broader (e.g. a duration-based cutoff instead of a
// poll-count one).
export function collapseIsolatedBlips(segments) {
  if (segments.length < 3) return segments;

  const result = [segments[0]];
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const prev = result[result.length - 1];
    const next = segments[i + 1];
    const isIsolatedBlip = seg.sampleCount === 1 && next && prev.status === next.status && prev.status !== seg.status;
    if (isIsolatedBlip) {
      prev.end = next.end;
      prev.durationMinutes = (prev.end.getTime() - prev.start.getTime()) / 60000;
      prev.sampleCount += seg.sampleCount + next.sampleCount;
      i += 1; // `next` is now absorbed into prev too - skip it
    } else {
      result.push(seg);
    }
  }
  return result;
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
