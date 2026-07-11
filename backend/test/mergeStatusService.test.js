// Regression baseline for mergeStatusService.js, written BEFORE the Stage 2
// weighted-vote rewrite (see the refactor plan) - captures today's pairwise
// combineTwo()/mergeFuelStatuses()/mergeOverallStatus() truth table so the
// rewrite can be verified byte-for-byte equivalent at tbank=gdebenz=1.0
// trust weight, rather than trusting the rewrite "by inspection".
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  combineTwo,
  mergeFuelStatuses,
  mergeOverallStatus,
  mergeStationFuelStatuses,
  resolveVotes,
} = require('../src/services/mergeStatusService');

test('combineTwo: no_data/undefined defers entirely to the other side', () => {
  assert.equal(combineTwo('no_data', 'available'), 'available');
  assert.equal(combineTwo('available', 'no_data'), 'available');
  assert.equal(combineTwo(undefined, 'not_available'), 'not_available');
  assert.equal(combineTwo('not_available', undefined), 'not_available');
  assert.equal(combineTwo('no_data', 'no_data'), 'no_data');
  assert.equal(combineTwo(undefined, undefined), 'no_data');
});

test('combineTwo: agreement passes through unchanged', () => {
  assert.equal(combineTwo('available', 'available'), 'available');
  assert.equal(combineTwo('maybe_available', 'maybe_available'), 'maybe_available');
  assert.equal(combineTwo('not_available', 'not_available'), 'not_available');
});

test('combineTwo: maybe_available is weak evidence, outvoted by a confirmed reading', () => {
  assert.equal(combineTwo('maybe_available', 'available'), 'available');
  assert.equal(combineTwo('available', 'maybe_available'), 'available');
  assert.equal(combineTwo('maybe_available', 'not_available'), 'not_available');
  assert.equal(combineTwo('not_available', 'maybe_available'), 'not_available');
});

test('combineTwo: two confirmed but disagreeing readings become maybe_available', () => {
  assert.equal(combineTwo('available', 'not_available'), 'maybe_available');
  assert.equal(combineTwo('not_available', 'available'), 'maybe_available');
});

test('mergeOverallStatus mirrors combineTwo directly', () => {
  assert.equal(mergeOverallStatus('available', 'not_available'), 'maybe_available');
  assert.equal(mergeOverallStatus('no_data', 'available'), 'available');
  assert.equal(mergeOverallStatus('maybe_available', 'not_available'), 'not_available');
});

test('mergeFuelStatuses: gdebenz not_available applies uniformly to every tbank fuel type', () => {
  const merged = mergeFuelStatuses(
    [
      { fuelType: '92', status: 'available' },
      { fuelType: '95', status: 'not_available' },
    ],
    'not_available',
    []
  );
  assert.deepEqual(
    merged.sort((a, b) => a.fuelType.localeCompare(b.fuelType)),
    [
      { fuelType: '92', status: 'maybe_available' },
      { fuelType: '95', status: 'not_available' },
    ]
  );
});

test('mergeFuelStatuses: gdebenz available only says something about the fuel types it lists', () => {
  const merged = mergeFuelStatuses(
    [
      { fuelType: '92', status: 'available' },
      { fuelType: '95', status: 'not_available' },
    ],
    'available',
    ['92']
  );
  const byType = Object.fromEntries(merged.map((f) => [f.fuelType, f.status]));
  assert.equal(byType['92'], 'available'); // agreement
  assert.equal(byType['95'], 'not_available'); // gdebenz has no opinion on 95, tbank's reading stands
});

test('mergeFuelStatuses: gdebenz no_data/undefined leaves tbank untouched', () => {
  const tbank = [
    { fuelType: '92', status: 'available' },
    { fuelType: '95', status: 'not_available' },
  ];
  assert.deepEqual(mergeFuelStatuses(tbank, 'no_data', []), tbank);
  assert.deepEqual(mergeFuelStatuses(tbank, undefined, undefined), tbank);
});

test('resolveVotes: a source with no reading simply does not vote (absent, not a 0 vote)', () => {
  assert.equal(resolveVotes([]).status, 'no_data');
  assert.equal(resolveVotes([{ status: 'available', weight: 1 }]).status, 'available');
});

test('resolveVotes: a weight-0 source (see sourceRegistry.js sberazs entry) never asserts anything on its own', () => {
  // Unlike an "absent" reading (filtered out entirely, see the test above),
  // a weight-0 reading is still a candidate vote but contributes nothing to
  // totalWeight - the totalWeight<=0 guard is what keeps it from asserting
  // a confirmed status even when it's the only source with an opinion,
  // which any weight>0 would fail to do (weight cancels out in a
  // single-voter weighted average regardless of how small it is).
  assert.equal(resolveVotes([{ status: 'available', weight: 0 }]).status, 'no_data');
  assert.equal(resolveVotes([{ status: 'not_available', weight: 0 }]).status, 'no_data');
});

test('resolveVotes: a weight-0 source is fully overridden by any real voter, not just outvoted', () => {
  const withDissent = resolveVotes([
    { status: 'not_available', weight: 1 },
    { status: 'available', weight: 0 },
  ]);
  assert.equal(withDissent.status, 'not_available');
  assert.equal(withDissent.confidence, 1); // no dilution at all, unlike a real (weight>0) disagreement
});

test('resolveVotes: a 2-1 split among equally-weighted sources is not confident enough to confirm', () => {
  // score = (1 + 1 - 1) / 3 = 0.33, below the +/-0.5 confirm threshold - a
  // slim majority among equal-trust sources is deliberately still reported
  // as maybe_available (genuine disagreement), not resolved by headcount.
  // Whether a "majority wins" rule should exist once 3+ sources are common
  // is a real, separate decision for whenever a third source is actually
  // added (see the plan's deferred Stage 5) - not decided here.
  const split = resolveVotes([
    { status: 'available', weight: 1 },
    { status: 'available', weight: 1 },
    { status: 'not_available', weight: 1 },
  ]);
  assert.equal(split.status, 'maybe_available');
  assert.ok(split.confidence > 0 && split.confidence < 0.5);
});

test('resolveVotes: a high enough trust weight can outweigh multiple lower-weight dissenters', () => {
  // score = (9 - 1 - 1) / 11 = 0.636 >= 0.5 - demonstrates the weight field
  // (see sourceRegistry.js) actually has teeth once it's set away from the
  // equal-trust default, without needing a 3rd real source to prove it.
  const trusted = resolveVotes([
    { status: 'available', weight: 9 },
    { status: 'not_available', weight: 1 },
    { status: 'not_available', weight: 1 },
  ]);
  assert.equal(trusted.status, 'available');
});

test('mergeFuelStatuses: a fuel type gdebenz mentions that tbank never reported still surfaces', () => {
  const merged = mergeFuelStatuses(
    [{ fuelType: '92', status: 'not_available' }],
    'available',
    ['98']
  );
  const byType = Object.fromEntries(merged.map((f) => [f.fuelType, f.status]));
  assert.equal(byType['98'], 'available');
  assert.equal(byType['92'], 'not_available');
});

// sberazs's own per-fuel-type readings (see sberazsParser.js's
// parseFuelStatuses / sourceRegistry.js's fuelStatusWeight) - a genuinely
// better signal than the old blanket station-status projection, so it takes
// priority per fuel type when present instead of being projected.
test('mergeStationFuelStatuses: a fuelStatuses entry is used directly, not projected', () => {
  const merged = mergeStationFuelStatuses(
    [{ fuelType: '92', status: 'no_data' }],
    [
      {
        status: 'available', // station-level - would otherwise project onto every listed type
        fuelTypes: ['92', '95'],
        weight: 0, // sberazs's blanket weight - see sourceRegistry.js
        fuelStatuses: [{ fuelType: '92', status: 'not_available' }], // contradicts the blanket status
        fuelStatusWeight: 1,
      },
    ]
  );
  const byType = Object.fromEntries(merged.map((f) => [f.fuelType, f.status]));
  // '92' has its own per-fuel reading (not_available, at weight 1) - wins
  // outright over tbank's no_data, ignoring the station-level "available"
  // entirely for this type.
  assert.equal(byType['92'], 'not_available');
  // '95' has no per-fuel entry - falls back to projecting the station-level
  // status at the blanket weight (0), so it still can't assert anything on
  // its own.
  assert.equal(byType['95'], 'no_data');
});

test('mergeStationFuelStatuses: an explicit per-fuel "unknown" (no_data) suppresses projection instead of inheriting the station-level status', () => {
  const merged = mergeStationFuelStatuses(
    [],
    [
      {
        status: 'available',
        fuelTypes: ['92', '95'],
        weight: 0,
        fuelStatuses: [{ fuelType: '95', status: 'no_data' }],
        fuelStatusWeight: 1,
      },
    ]
  );
  const byType = Object.fromEntries(merged.map((f) => [f.fuelType, f.status]));
  // '95' explicitly has no per-fuel opinion (mapped from sberazs's own
  // "unknown") - stays no_data, doesn't fall back to the station-level
  // "available" the way an un-upgraded station's blank fuels[] entry would.
  assert.equal(byType['95'], 'no_data');
  // '92' has no fuelStatuses entry at all for this source - old projection
  // path still applies, but at the blanket (0) weight, so it can't confirm
  // anything on its own either.
  assert.equal(byType['92'], 'no_data');
});

test('mergeStationFuelStatuses: gdebenz-shaped readings (no fuelStatuses at all) are unaffected by the new per-type path', () => {
  const merged = mergeStationFuelStatuses(
    [{ fuelType: '92', status: 'available' }],
    [{ status: 'not_available', fuelTypes: [], weight: 1 }]
  );
  // Same truth table as the pre-existing "not_available applies uniformly" test.
  assert.deepEqual(merged, [{ fuelType: '92', status: 'maybe_available' }]);
});
