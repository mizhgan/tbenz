// Raw station objects are built inline (not a static JSON fixture like
// sberazsSample.json) since the behavior under test - staleness of
// last_transaction_at - is relative to Date.now(), not a fixed point in
// time; a static "2026-01-01" timestamp would silently stop exercising the
// stale path once enough real time has passed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseStation, extractStationsArray } = require('../src/services/alfabankParser');

const HOUR_MS = 60 * 60 * 1000;
const isoHoursAgo = (hours) => new Date(Date.now() - hours * HOUR_MS).toISOString();

function fuel(category, status, hoursAgo) {
  return { category, status, last_transaction_at: hoursAgo === null ? undefined : isoHoursAgo(hoursAgo), price: null };
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

test('parseStation: a fresh (<4h) "available" reading passes through as available', () => {
  const parsed = parseStation(station({ fuels: [fuel('AI92', 'available', 2)] }));
  assert.equal(parsed.fuelStatuses[0].status, 'available');
  assert.equal(parsed.status, 'available'); // single-fuel overall vote mirrors it
});

test('parseStation: a stale (>4h) "available" reading is downgraded to no_data', () => {
  const parsed = parseStation(station({ fuels: [fuel('AI92', 'available', 20)] }));
  assert.equal(parsed.fuelStatuses[0].status, 'no_data');
});

// "available" uses its own, much stricter 4h bar than probably_unavailable/
// unavailable's shared 12h one (see alfabankParser.js's own doc comment on
// why - a stale "available" over-reports, which is the worse failure for a
// source that's sometimes the only vote a station gets at all) - this is
// exactly the boundary where the two bars now disagree: 6h is stale for
// "available" but would still be fresh under the old (and still-current
// for the other two statuses) 12h bar.
test('parseStation: a 6h-old "available" reading is stale under its own 4h bar, even though 6h would pass the 12h bar the other statuses use', () => {
  const parsed = parseStation(station({ fuels: [fuel('AI92', 'available', 6)] }));
  assert.equal(parsed.fuelStatuses[0].status, 'no_data');
});

test('parseStation: a stale (>12h) "probably_unavailable" is downgraded to no_data, not maybe_available', () => {
  const parsed = parseStation(station({ fuels: [fuel('AI92', 'probably_unavailable', 27 * 24)] }));
  assert.equal(parsed.fuelStatuses[0].status, 'no_data');
});

test('parseStation: a fresh (<12h) "probably_unavailable" still reads as maybe_available', () => {
  const parsed = parseStation(station({ fuels: [fuel('AI92', 'probably_unavailable', 6)] }));
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
        fuel('AI95', 'closed', 60 * 24),
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
        fuel('AI92', 'available', 1),
        fuel('AI95', 'available', 1),
        fuel('AI98_100', 'available', 1),
        fuel('DIESEL', 'available', 1),
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
