// available/not_available are opposite poles, maybe_available sits at the
// midpoint (weak evidence in either direction) - a weighted average of these
// scores, thresholded at +/-0.5, is what resolveVotes below runs on N
// readings at once instead of exactly two.
const STATUS_SCORE = { available: 1, maybe_available: 0, not_available: -1 };
const CONFIRM_THRESHOLD = 0.5;

// Mirrors secondarySourceIngestService.js's own AVAILABLE_LIKE (kept as a
// separate copy rather than a shared import - this module is the pure,
// dependency-free one the other one's doc comments explicitly point to for
// unit testing, and pulling in a sibling service just for one Set isn't
// worth losing that).
const AVAILABLE_LIKE_STATUSES = new Set(['available', 'maybe_available']);

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
 * above, kept for mergeFuelStatuses/mergeOverallStatus's own two-source
 * callers.
 *
 * Rule: agreement is confirmed as-is; a real contradiction (one source says
 * available, the other not_available) becomes maybe_available rather than
 * picking a side - the app has no way to know which source is right, so it
 * says so instead of guessing. "maybe_available" from either side is weaker
 * evidence than a confirmed reading from the other, so it's outvoted by
 * whichever side IS confirmed (available or not_available) rather than
 * diluting that confirmed reading down to uncertain.
 *
 * Not called by the ingest path anymore (see mergeStationOverallStatus/
 * mergeStationFuelStatuses below, used by secondarySourceIngestService.js) -
 * kept as the regression-tested two-source reference implementation.
 */
function combineTwo(a, b) {
  return resolveVotes([
    { status: a, weight: 1 },
    { status: b, weight: 1 },
  ]).status;
}

// A secondary source (gdebenz today, others later - see sourceRegistry.js)
// reports at station granularity, not per fuel type: `status` is the
// station's overall mapped status, and `fuelTypes` is which specific types
// it currently claims are available (only meaningful when `status` itself
// is available-like). A "not_available" is treated as applying to every
// fuel type uniformly (no fuel at this station at all); an "available"/
// "maybe_available" only says something about the specific types it
// actually lists - for a type it doesn't mention, this source simply has no
// opinion on that type, same as if it hadn't reported at all.
function projectStationStatusOntoFuelType(status, fuelTypes, fuelType) {
  if (status === 'not_available') return 'not_available';
  if (status === 'no_data' || status === undefined) return undefined;
  return (fuelTypes || []).includes(fuelType) ? status : undefined;
}

/**
 * Merges tbank's per-fuel-type statuses with any number of matched
 * secondary sources' readings into one merged per-fuel-type list - the
 * N-source generalization of mergeFuelStatuses below. `secondaryReadings` is
 * `[{status, fuelTypes, weight, fuelStatuses?, fuelStatusWeight?, isEquipmentList?}]`,
 * one entry per currently-linked secondary source (see Station.sourceLinks),
 * not just the one that happened to poll most recently.
 *
 * `fuelStatuses` (optional, e.g. sberazs once it has per-fuel data - see
 * sberazsParser.js) is a strictly better signal than the station-level
 * projection below: when present for a given fuel type, it's used directly
 * (at `fuelStatusWeight`, falling back to the reading's own `weight` if
 * unset) instead of projectStationStatusOntoFuelType. A source with no
 * fuelStatuses at all (gdebenz, or an un-upgraded sberazs station) is
 * untouched by this - same projection behavior as before.
 *
 * `isEquipmentList` (optional, true for sberazs - see sourceRegistry.js)
 * marks a reading whose `fuelTypes` names the station's actual physical
 * pumps, not (like gdebenz's `fuels_now`) just what's currently available -
 * an empty list from a *non*-equipment source means "nothing available
 * right now", but an equipment source explicitly leaving a type off the
 * list means "this station doesn't have that pump at all". Confirmed live:
 * tbank's statusByFuelType always carries a fixed baseline of "92"/"95" for
 * every station regardless of what it actually sells (its own API sample
 * in stationParser.js's doc comment already shows this), which occasionally
 * leaks a stray maybe_available/available onto a propane- or diesel-only
 * station that has no such pump at all. tbank's vote for a fuel type no
 * equipment-list source corroborates is dropped entirely here (not flipped
 * to not_available - the equipment lists seen aren't guaranteed
 * exhaustive, so "no evidence" is the honest result, not "confirmed
 * absent") whenever at least one equipment-list reading has real data to
 * check against.
 */
// Every fuel type at least one equipment-list source (sberazs today) has
// actually reported as a physical pump - shared between mergeStationFuelStatuses
// and mergeStationOverallStatus below, since an uncorroborated claim should
// be discounted the same way whether it shows up as a specific fuel type's
// merged status or as the station's own blanket overall status.
function deriveKnownEquipment(secondaryReadings) {
  const knownEquipment = new Set();
  for (const r of secondaryReadings) {
    if (!r.isEquipmentList) continue;
    for (const fuelType of r.fuelTypes || []) knownEquipment.add(fuelType);
  }
  return knownEquipment;
}

function mergeStationFuelStatuses(tbankFuelStatuses, secondaryReadings) {
  const byType = new Map((tbankFuelStatuses || []).map((f) => [f.fuelType, f.status]));
  const allTypes = new Set(byType.keys());
  for (const r of secondaryReadings) {
    for (const fuelType of r.fuelTypes || []) allTypes.add(fuelType);
    for (const f of r.fuelStatuses || []) allTypes.add(f.fuelType);
  }

  const knownEquipment = deriveKnownEquipment(secondaryReadings);

  const merged = [];
  for (const fuelType of allTypes) {
    // Once at least one equipment-list source (sberazs today) has reported
    // its actual pumps, a fuel type it doesn't list is positive evidence
    // the station simply doesn't have that pump - so a *blanket, projected*
    // claim about that type (tbank's fixed baseline below, or a secondary
    // source's own station-level status+fuelTypes guess via
    // projectStationStatusOntoFuelType) is dropped here rather than trusted.
    // A source's *genuine* per-fuel-type reading (a real fuelStatuses entry
    // - alfabank always, sberazs once upgraded) is NOT dropped by this: it's
    // real transaction-derived evidence for that exact type, not a guess
    // smeared across whatever the source's fuelTypes list happens to say,
    // and an equipment list that's silent (or stale/incomplete) on that type
    // isn't grounds to override it - confirmed live on a real multi-fuel
    // "Движение" station (Кировская область, Зуевский район, деревня Зуи):
    // sberazs's equipment list only knew about its propane/methane pumps,
    // but alfabank had genuine, hours-fresh transaction data for 92/ДТ at
    // the same station - an earlier version of this fix wrongly silenced
    // that real evidence too. Equipment-list sources themselves are always
    // exempt - they're what defines knownEquipment in the first place. The
    // *projected* path is exactly what let a real bug through before any of
    // this existed: a pure-propane АГЗС ("АГЗС Пропан", Киров, ЖК Слобода
    // Курочкины) had gdebenz - a crowdsourced source people manually mark
    // fuel availability on, with no real per-fuel data behind it - wrongly
    // claiming 92/95/ДТ available (a mis-tag), which sberazs's equipment
    // list (fuelTypes:["propane"]) should have overridden but didn't:
    // only tbank's baseline was being dropped this way, so gdebenz's lone
    // uncorroborated projected claim alone was enough to swing the merged
    // result to "available".
    const uncorroborated = knownEquipment.size > 0 && !knownEquipment.has(fuelType);
    const votes = [{ status: uncorroborated ? undefined : byType.get(fuelType), weight: 1 }];
    for (const r of secondaryReadings) {
      const perFuelEntry = (r.fuelStatuses || []).find((f) => f.fuelType === fuelType);
      // No perFuelEntry at all is always a projection; one marked
      // stationClosed (alfabank's "closed" flag - see alfabankParser.js)
      // counts as one too despite living in the same fuelStatuses array
      // genuine readings do - it's the same kind of station-wide claim
      // smeared across every fixed category that gdebenz's blanket
      // projection is, not real per-pump evidence.
      const isStationWideClaim = !perFuelEntry || perFuelEntry.stationClosed;
      if (!r.isEquipmentList && uncorroborated && isStationWideClaim) continue;

      if (perFuelEntry) {
        votes.push({ status: perFuelEntry.status, weight: r.fuelStatusWeight ?? r.weight });
      } else {
        votes.push({ status: projectStationStatusOntoFuelType(r.status, r.fuelTypes, fuelType), weight: r.weight });
      }
    }
    merged.push({ fuelType, status: resolveVotes(votes).status });
  }
  return merged;
}

// The station-level "lastStatus" summary field mirrors how stationParser.js
// derives it for tbank (worst-known-wins isn't used here; overall status is
// its own value from the source, not derived from the per-fuel breakdown) -
// so the merged overall status is likewise a vote across every source's own
// overall reading, not re-derived from mergeStationFuelStatuses' output.
//
// A non-equipment-list reading's "available"/"maybe_available" overall
// claim is dropped here under the same condition mergeStationFuelStatuses
// drops it per-type: at least one equipment-list source has reported real
// pumps, and none of *this* reading's own claimed fuelTypes are among them
// - i.e. every fuel type it's claiming available is one the station
// provably doesn't have, so the claim has nothing genuine behind it. Only
// applies to a reading with no genuine `fuelStatuses` backing at all
// (gdebenz-shaped) - one with real per-fuel entries (alfabank; see
// mergeStationFuelStatuses' own doc comment for why) is exempt here too,
// same reasoning: an incomplete/stale equipment list isn't grounds to
// override real transaction evidence. A "not_available" claim is left alone
// (it doesn't need a specific fuel type to be meaningful - see
// projectStationStatusOntoFuelType's own doc comment), and equipment-list
// sources' own overall vote is exempt (already weight-0 for sberazs
// regardless - see sourceRegistry.js). tbank's blanket overall status isn't
// checked against knownEquipment here: unlike its per-fuel breakdown
// (tbankLastFuelStatuses, handled in mergeStationFuelStatuses), this
// function only ever sees tbank's single summary string, with no per-fuel
// scope to check corroboration against.
function mergeStationOverallStatus(tbankStatus, secondaryReadings) {
  const knownEquipment = deriveKnownEquipment(secondaryReadings);
  const votes = [{ status: tbankStatus, weight: 1 }];
  for (const r of secondaryReadings) {
    const claimsOnlyUncorroboratedTypes =
      !r.isEquipmentList &&
      !(r.fuelStatuses || []).length &&
      knownEquipment.size > 0 &&
      AVAILABLE_LIKE_STATUSES.has(r.status) &&
      (r.fuelTypes || []).length > 0 &&
      !(r.fuelTypes || []).some((t) => knownEquipment.has(t));
    if (claimsOnlyUncorroboratedTypes) continue;
    votes.push({ status: r.status, weight: r.weight });
  }
  return resolveVotes(votes).status;
}

/**
 * Two-source, equal-weight special case of mergeStationFuelStatuses - kept
 * for the existing regression-tested truth table (see
 * backend/test/mergeStatusService.test.js); the generic ingest runner
 * (secondarySourceIngestService.js) calls mergeStationFuelStatuses directly
 * with every linked secondary source instead.
 */
function mergeFuelStatuses(tbankFuelStatuses, gdebenzStatus, gdebenzFuelTypes) {
  return mergeStationFuelStatuses(tbankFuelStatuses, [{ status: gdebenzStatus, fuelTypes: gdebenzFuelTypes, weight: 1 }]);
}

function mergeOverallStatus(tbankStatus, gdebenzStatus) {
  return mergeStationOverallStatus(tbankStatus, [{ status: gdebenzStatus, weight: 1 }]);
}

module.exports = {
  combineTwo,
  mergeFuelStatuses,
  mergeOverallStatus,
  mergeStationFuelStatuses,
  mergeStationOverallStatus,
  resolveVotes,
};
