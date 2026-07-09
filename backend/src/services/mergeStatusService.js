// available/not_available are opposite poles, maybe_available sits at the
// midpoint (weak evidence in either direction) - a weighted average of these
// scores, thresholded at +/-0.5, is what resolveVotes below runs on N
// readings at once instead of exactly two.
const STATUS_SCORE = { available: 1, maybe_available: 0, not_available: -1 };
const CONFIRM_THRESHOLD = 0.5;

/**
 * N-way weighted-vote resolver: takes any number of `{status, weight}`
 * readings (a source with nothing to say simply isn't in the list - see
 * combineTwo below for how no_data/undefined get filtered out before this
 * point) and produces one merged status plus a confidence score (the
 * absolute weighted score, 0 = a genuine tie/conflict, 1 = every voting
 * source fully agrees).
 *
 * At equal weight (1.0) for every reading, this exactly reproduces the
 * original two-source combineTwo() truth table (verified in
 * backend/test/mergeStatusService.test.js): agreement passes through,
 * maybe_available is weak evidence outvoted by a confirmed reading, and two
 * confirmed-but-disagreeing readings land at score 0 - "genuine conflict",
 * same as before. A *different* weight per source is what actually changes
 * behavior (a low-trust source's "not_available" no longer fully cancels
 * out a high-trust source's "available") - that's a deliberate, separate
 * policy change (see sourceRegistry.js's weight field), not something this
 * function decides on its own.
 */
function resolveVotes(readings) {
  const votes = (readings || []).filter((r) => r && Object.prototype.hasOwnProperty.call(STATUS_SCORE, r.status));
  const totalWeight = votes.reduce((sum, r) => sum + r.weight, 0);
  if (!votes.length || totalWeight <= 0) return { status: 'no_data', confidence: 0 };

  const score = votes.reduce((sum, r) => sum + STATUS_SCORE[r.status] * r.weight, 0) / totalWeight;
  let status;
  if (score >= CONFIRM_THRESHOLD) status = 'available';
  else if (score <= -CONFIRM_THRESHOLD) status = 'not_available';
  else status = 'maybe_available';

  return { status, confidence: Math.abs(score) };
}

/**
 * Combines a status from tbank with a status from gdebenz for a single
 * fuel type into one "effective" status. Pure and synchronous - no model
 * access here, so it's cheap to unit-test every combination directly (see
 * backend/test/mergeStatusService.test.js) and cheap to call once per fuel
 * type per poll. A thin two-source, equal-weight wrapper over resolveVotes
 * above - kept so existing callers (mergeFuelStatuses/mergeOverallStatus,
 * and transitively gdebenzIngestService.js) don't need to change.
 *
 * Rule: agreement is confirmed as-is; a real contradiction (one source says
 * available, the other not_available) becomes maybe_available rather than
 * picking a side - the app has no way to know which source is right, so it
 * says so instead of guessing. "maybe_available" from either side is weaker
 * evidence than a confirmed reading from the other, so it's outvoted by
 * whichever side IS confirmed (available or not_available) rather than
 * diluting that confirmed reading down to uncertain.
 */
function combineTwo(a, b) {
  return resolveVotes([
    { status: a, weight: 1 },
    { status: b, weight: 1 },
  ]).status;
}

/**
 * Merges tbank's per-fuel-type statuses with a matched gdebenz station's
 * reading into one merged per-fuel-type list.
 *
 * gdebenz reports at station granularity, not per fuel type - `gdebenzStatus`
 * is the station's overall mapped status, and `gdebenzFuelTypes` is which
 * specific types it currently claims are available (only meaningful when
 * gdebenzStatus itself is available-like). A gdebenz "not_available" is
 * treated as applying to every fuel type uniformly (no fuel at this station
 * at all); a gdebenz "available"/"maybe_available" only says something about
 * the specific types it actually lists - for a type it doesn't mention,
 * gdebenz simply has no opinion, same as if it hadn't reported at all.
 */
function mergeFuelStatuses(tbankFuelStatuses, gdebenzStatus, gdebenzFuelTypes) {
  const gdebenzFuelSet = new Set(gdebenzFuelTypes || []);
  const byType = new Map((tbankFuelStatuses || []).map((f) => [f.fuelType, f.status]));
  const allTypes = new Set([...byType.keys(), ...gdebenzFuelSet]);

  const merged = [];
  for (const fuelType of allTypes) {
    const tStatus = byType.get(fuelType);

    let gStatusForType;
    if (gdebenzStatus === 'not_available') {
      gStatusForType = 'not_available';
    } else if (gdebenzStatus === 'no_data' || gdebenzStatus === undefined) {
      gStatusForType = undefined;
    } else {
      gStatusForType = gdebenzFuelSet.has(fuelType) ? gdebenzStatus : undefined;
    }

    merged.push({ fuelType, status: combineTwo(tStatus, gStatusForType) });
  }
  return merged;
}

// The station-level "lastStatus" summary field mirrors how stationParser.js
// derives it for tbank (worst-known-wins isn't used here; overall status is
// its own value from the source, not derived from the per-fuel breakdown) -
// so the merged overall status is likewise combineTwo() of the two sources'
// own overall readings, not re-derived from mergeFuelStatuses' output.
function mergeOverallStatus(tbankStatus, gdebenzStatus) {
  return combineTwo(tbankStatus, gdebenzStatus);
}

module.exports = { combineTwo, mergeFuelStatuses, mergeOverallStatus, resolveVotes };
