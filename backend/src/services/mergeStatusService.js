/**
 * Combines a status from tbank with a status from gdebenz for a single
 * fuel type into one "effective" status. Pure and synchronous - no model
 * access here, so it's cheap to unit-test every combination directly (see
 * the standalone test run during verification) and cheap to call once per
 * fuel type per poll.
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
  if (a === 'no_data' || a === undefined) return b ?? 'no_data';
  if (b === 'no_data' || b === undefined) return a ?? 'no_data';
  if (a === b) return a;
  if (a === 'maybe_available') return b;
  if (b === 'maybe_available') return a;
  // Both confirmed (available/not_available) but disagree - a genuine
  // conflict between the two sources.
  return 'maybe_available';
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

module.exports = { combineTwo, mergeFuelStatuses, mergeOverallStatus };
