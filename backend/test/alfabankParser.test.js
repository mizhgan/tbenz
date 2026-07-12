// Raw station objects are built inline (not a static JSON fixture like
// sberazsSample.json) since the behavior under test - staleness of
// last_transaction_at - is relative to Date.now(), not a fixed point in
// time; a static "2026-01-01" timestamp would silently stop exercising the
// stale path once enough real time has passed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseStation, extractStationsArray } = require('../src/services/alfabankParser');

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDaysAgo = (days) => new Date(Date.now() - days * DAY_MS).toISOString();

function fuel(category, status, daysAgo) {
  return { category, status, last_transaction_at: daysAgo === null ? undefined : isoDaysAgo(daysAgo), price: null };
}

function station(overrides) {
  return {
    station_id: 'test-id',
    brand: { name: 'Тестбренд' },
    address: { fullname: 'Тестовая ул., 1', location: { latitude: 58.6, longitude: 49.6 } },
    fuels: [],
    ...overrides,
  };
}

test('extractStationsArray reads a flat array with no wrapper object', () => {
  assert.deepEqual(extractStationsArray([station({})]).length, 1);
  assert.deepEqual(extractStationsArray({ stations: [] }), []); // no wrapper support needed - never seen live
});

test('parseStation: a fresh "available" reading passes through as available', () => {
  const parsed = parseStation(station({ fuels: [fuel('AI92', 'available', 0.5)] }));
  assert.equal(parsed.fuelStatuses[0].status, 'available');
  assert.equal(parsed.status, 'available'); // single-fuel overall vote mirrors it
});

test('parseStation: a stale (>7d) "probably_unavailable" is downgraded to no_data, not maybe_available', () => {
  const parsed = parseStation(station({ fuels: [fuel('AI92', 'probably_unavailable', 27)] }));
  assert.equal(parsed.fuelStatuses[0].status, 'no_data');
});

test('parseStation: a fresh (<7d) "probably_unavailable" still reads as maybe_available', () => {
  const parsed = parseStation(station({ fuels: [fuel('AI92', 'probably_unavailable', 2)] }));
  assert.equal(parsed.fuelStatuses[0].status, 'maybe_available');
});

test('parseStation: "probably_unavailable" with no last_transaction_at at all is treated as stale', () => {
  const parsed = parseStation(station({ fuels: [fuel('AI92', 'probably_unavailable', null)] }));
  assert.equal(parsed.fuelStatuses[0].status, 'no_data');
});

test('parseStation: "closed" is not_available regardless of last_transaction_at age (station-level flag, not staleness)', () => {
  const parsed = parseStation(
    station({
      fuels: [
        fuel('AI92', 'closed', null),
        fuel('AI95', 'closed', 60),
        fuel('AI98_100', 'closed', null),
        fuel('DIESEL', 'closed', null),
      ],
    })
  );
  assert.deepEqual(
    parsed.fuelStatuses.map((f) => f.status),
    ['not_available', 'not_available', 'not_available', 'not_available']
  );
  assert.equal(parsed.status, 'not_available');
});

test('parseStation: fuel type/name mapping - AI92/AI95/AI98_100 -> bare numbers, DIESEL -> ДТ', () => {
  const parsed = parseStation(
    station({
      fuels: [
        fuel('AI92', 'available', 0.1),
        fuel('AI95', 'available', 0.1),
        fuel('AI98_100', 'available', 0.1),
        fuel('DIESEL', 'available', 0.1),
      ],
    })
  );
  assert.deepEqual(
    parsed.fuelStatuses.map((f) => f.fuelType).sort(),
    ['100', '92', '95', 'ДТ']
  );
});

test('parseStation: a station missing lat/lon is rejected', () => {
  const raw = station({ address: { fullname: 'no coords', location: {} } });
  assert.equal(parseStation(raw), null);
});

test('parseStation: overall status is a weighted vote across this source\'s own fuel readings', () => {
  // Two confirmed "available" (fresh) outvote one stale "probably_unavailable"
  // (downgraded to no_data, so it doesn't even get to vote).
  const parsed = parseStation(
    station({
      fuels: [fuel('AI92', 'available', 0.1), fuel('AI95', 'available', 0.1), fuel('DIESEL', 'probably_unavailable', 20)],
    })
  );
  assert.equal(parsed.status, 'available');
});
