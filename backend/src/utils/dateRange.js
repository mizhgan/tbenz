const { HttpError } = require('../middleware/errorHandler');

// Shared by every metrics-style endpoint (regions.routes.js's
// /metrics/*, stations.routes.js's /:id/metrics) - factored out of
// metrics.controller.js so a new endpoint gets the same 5-minute rounding
// by construction instead of by remembering to copy it. Rounding matters
// more than it looks like it should: without it, a fresh "now" on every
// request means every visitor gets its own cache key and the metrics
// caching (memoizeAsync's TTL, this module's own Cache-Control header)
// never actually hits for real traffic - see metrics.controller.js's git
// history for the measured cost of that (a cold region-wide station-metrics
// query took ~2.7s, paid by every single visitor).
const RANGE_ROUND_MS = 5 * 60 * 1000;

// Shared cap for every metrics/history-style endpoint's own maxRangeMs.
// Used to be 92 days per controller, picked as "headroom" over the reports
// page's widest 30-day preset without ever being load-tested - a real
// 72-day custom report (free-typed into the datetime-local inputs, not one
// of the preset buttons) OOM-killed mongod in production: getStationMetrics
// et al used to materialize every raw snapshot doc for the whole window in
// memory (~100 stations x 72 days x 144 polls/day is ~1M docs). Dropped to
// 35 days as an immediate stopgap after that incident.
//
// Since then, getStationMetrics/getRecoveryTrend were rewritten to a
// Mongo $group aggregation plus a separately-maintained StationOutage log
// (see that model's own doc comment) instead of pulling raw docs into
// Node - the OOM mechanism itself is gone, not just capped further away
// from. Re-measured live on production after that rewrite (3.8GB RAM, 2
// CPU host, same one that crashed): 35 days ~2s, the region's full 66-day
// history (all the data that exists so far) ~3.9s for getStationMetrics,
// getRecoveryTrend down to tens of milliseconds regardless of range (reads
// the small outage log, not raw snapshots). 180 days extrapolates to a
// comfortably non-dangerous ~10s worst case from that trend - real crash
// risk is gone, cost now is response latency, not memory. The region has no
// data older than ~66 days yet, so a true ~366-day range is unmeasurable
// for real until history actually accumulates that far - re-measure then
// before raising this further, same as last time: from real numbers, not a
// guess.
const MAX_SAFE_RANGE_MS = 180 * 24 * 60 * 60 * 1000;

function roundDown(date) {
  return new Date(Math.floor(date.getTime() / RANGE_ROUND_MS) * RANGE_ROUND_MS);
}

function parseRange(query, { defaultRangeMs, maxRangeMs }) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - defaultRangeMs);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new HttpError(400, 'Invalid "from"/"to" timestamp');
  }
  if (from >= to) {
    throw new HttpError(400, '"from" must be before "to"');
  }
  if (to.getTime() - from.getTime() > maxRangeMs) {
    throw new HttpError(400, `Range too wide - max ${maxRangeMs / (24 * 60 * 60 * 1000)} days`);
  }
  const roundedFrom = roundDown(from);
  const roundedTo = roundDown(to);
  // Only ever called with ranges of at least a day (the reports page's
  // shortest preset) - rounding both down by up to RANGE_ROUND_MS each
  // can't realistically collapse one, but this guards the theoretical edge
  // case (a very short custom range straddling one rounding bucket) by
  // falling back to the exact, unrounded values rather than ever returning
  // an inverted or empty range.
  if (roundedFrom >= roundedTo) return { from, to };
  return { from: roundedFrom, to: roundedTo };
}

module.exports = { parseRange, roundDown, RANGE_ROUND_MS, MAX_SAFE_RANGE_MS };
