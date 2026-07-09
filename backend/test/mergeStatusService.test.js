// Regression baseline for mergeStatusService.js, written BEFORE the Stage 2
// weighted-vote rewrite (see the refactor plan) - captures today's pairwise
// combineTwo()/mergeFuelStatuses()/mergeOverallStatus() truth table so the
// rewrite can be verified byte-for-byte equivalent at tbank=gdebenz=1.0
// trust weight, rather than trusting the rewrite "by inspection".
const test = require('node:test');
const assert = require('node:assert/strict');
const { combineTwo, mergeFuelStatuses, mergeOverallStatus } = require('../src/services/mergeStatusService');

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
