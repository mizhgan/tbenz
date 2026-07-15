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

module.exports = { parseRange, roundDown, RANGE_ROUND_MS };
