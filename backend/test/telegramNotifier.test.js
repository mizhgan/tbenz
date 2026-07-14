const test = require('node:test');
const assert = require('node:assert/strict');
const { chatMatchesFilters, computeTransitions } = require('../src/services/telegramNotifier');

function chat(overrides) {
  return { watchlist: [], fuelTypes: [], brands: [], ...overrides };
}

function station(overrides) {
  return { _id: 'station-1', name: 'Лукойл', ...overrides };
}

test('chatMatchesFilters: unconfigured fuelTypes (empty array) defaults to gasoline (92/95), not "all"', () => {
  const c = chat({});
  assert.equal(chatMatchesFilters(c, station(), '92'), true);
  assert.equal(chatMatchesFilters(c, station(), '95'), true);
  assert.equal(chatMatchesFilters(c, station(), 'ДТ'), false); // diesel - not core anymore
  assert.equal(chatMatchesFilters(c, station(), '100'), false); // premium grade - not core
  assert.equal(chatMatchesFilters(c, station(), 'propane'), false);
});

test('chatMatchesFilters: an explicit fuelTypes list overrides the gasoline default entirely', () => {
  const c = chat({ fuelTypes: ['propane'] });
  assert.equal(chatMatchesFilters(c, station(), 'propane'), true);
  assert.equal(chatMatchesFilters(c, station(), '92'), false); // not in the explicit list
});

test('chatMatchesFilters: a watchlisted station bypasses the fuel-type filter entirely, even for non-core types', () => {
  const c = chat({ watchlist: ['station-1'] });
  assert.equal(chatMatchesFilters(c, station({ _id: 'station-1' }), 'propane'), true);
});

test('chatMatchesFilters: brands filter still applies on top of the gasoline default', () => {
  const c = chat({ brands: ['Роснефть'] });
  assert.equal(chatMatchesFilters(c, station({ name: 'Лукойл' }), '92'), false);
  assert.equal(chatMatchesFilters(c, station({ name: 'Роснефть' }), '92'), true);
});

function fs(fuelType, status) {
  return { fuelType, status };
}

test('computeTransitions: a brand new fuel type (never in the raw previous poll) is not a transition, even if it starts available', () => {
  const { transitions, nextConfirmedFuelStatuses } = computeTransitions([], [], [fs('92', 'available')]);
  assert.deepEqual(transitions, []);
  // still recorded as the starting confirmed value for future ticks
  assert.deepEqual(nextConfirmedFuelStatuses, [fs('92', 'available')]);
});

test('computeTransitions: not_available -> available (seen before) fires stationAvailable', () => {
  const { transitions } = computeTransitions([fs('92', 'not_available')], [fs('92', 'not_available')], [fs('92', 'available')]);
  assert.deepEqual(transitions, [{ fuelType: '92', eventKey: 'stationAvailable' }]);
});

test('computeTransitions: available -> not_available (seen before, confirmed available) fires stationUnavailable', () => {
  const { transitions } = computeTransitions([fs('92', 'available')], [fs('92', 'available')], [fs('92', 'not_available')]);
  assert.deepEqual(transitions, [{ fuelType: '92', eventKey: 'stationUnavailable' }]);
});

// The exact bug report this whole redesign was for: a station flapping
// available <-> maybe_available (confirmed live as a common pattern, dozens
// of times per station in production) used to re-fire "появилось" on every
// maybe_available -> available flip, because the old comparison only looked
// one poll back. Comparing against confirmedFuelStatuses instead means a
// maybe_available reading never updates the memory, so this flip sees
// prevConfirmed still 'available' and produces no transition.
test('computeTransitions: maybe_available -> available produces no transition when already confirmed available (kills the reported flapping noise)', () => {
  const { transitions, nextConfirmedFuelStatuses } = computeTransitions(
    [fs('92', 'maybe_available')], // raw previous poll: maybe_available
    [fs('92', 'available')], // but still confirmed available from before that
    [fs('92', 'available')]
  );
  assert.deepEqual(transitions, []);
  assert.deepEqual(nextConfirmedFuelStatuses, [fs('92', 'available')]);
});

test('computeTransitions: maybe_available itself never fires a transition or updates the confirmed memory', () => {
  const { transitions, nextConfirmedFuelStatuses } = computeTransitions(
    [fs('92', 'available')],
    [fs('92', 'available')],
    [fs('92', 'maybe_available')]
  );
  assert.deepEqual(transitions, []);
  // memory still says 'available' - the maybe_available reading didn't touch it
  assert.deepEqual(nextConfirmedFuelStatuses, [fs('92', 'available')]);
});

// The other half of the same bug: a genuine available -> not_available
// transition used to go silent whenever the one poll right before the
// not_available reading happened to land on maybe_available, because the
// old raw-previous-only comparison saw maybe_available -> not_available,
// not the tracked available -> not_available pair. Simulated here as two
// ticks: first available -> maybe_available (no transition, confirmed
// memory stays 'available'), then that same confirmed memory carried into
// a second call where the raw previous is maybe_available but the reading
// finally lands on not_available - stationUnavailable still fires.
test('computeTransitions: available -> (maybe_available blip) -> not_available across two ticks still fires stationUnavailable', () => {
  const tick1 = computeTransitions([fs('92', 'available')], [fs('92', 'available')], [fs('92', 'maybe_available')]);
  assert.deepEqual(tick1.transitions, []);

  const tick2 = computeTransitions(
    [fs('92', 'maybe_available')], // raw previous poll (tick1's reading)
    tick1.nextConfirmedFuelStatuses, // still 'available' - the real memory
    [fs('92', 'not_available')]
  );
  assert.deepEqual(tick2.transitions, [{ fuelType: '92', eventKey: 'stationUnavailable' }]);
});

test('computeTransitions: a fuel type seen before but never yet confirmed (always maybe_available/no_data) fires stationAvailable on its first confirmed reading', () => {
  const { transitions } = computeTransitions(
    [fs('92', 'no_data')], // seen before (so not a "brand new fuel type"), but never confirmed
    [], // no confirmed memory at all yet
    [fs('92', 'available')]
  );
  assert.deepEqual(transitions, [{ fuelType: '92', eventKey: 'stationAvailable' }]);
});

test('computeTransitions: a never-confirmed fuel type going to not_available does not fire stationUnavailable', () => {
  const { transitions } = computeTransitions([fs('92', 'no_data')], [], [fs('92', 'not_available')]);
  assert.deepEqual(transitions, []);
});

test('computeTransitions: multiple fuel types are handled independently in one call', () => {
  const { transitions, nextConfirmedFuelStatuses } = computeTransitions(
    [fs('92', 'not_available'), fs('95', 'available')],
    [fs('92', 'not_available'), fs('95', 'available')],
    [fs('92', 'available'), fs('95', 'not_available'), fs('ДТ', 'maybe_available')]
  );
  assert.deepEqual(transitions.sort((a, b) => a.fuelType.localeCompare(b.fuelType)), [
    { fuelType: '92', eventKey: 'stationAvailable' },
    { fuelType: '95', eventKey: 'stationUnavailable' },
  ]);
  // ДТ (maybe_available) isn't in the output at all - never confirmed, no prior memory either
  assert.deepEqual(
    nextConfirmedFuelStatuses.sort((a, b) => a.fuelType.localeCompare(b.fuelType)),
    [fs('92', 'available'), fs('95', 'not_available')]
  );
});
