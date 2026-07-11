// Fixture is a trimmed real sberazs.ru response (see the diff that
// introduced per-fuel-type availabilityStatus - previously every station
// only had bare {"type": "..."} entries, no individual status). Covers the
// three shapes seen in practice: a station with genuine per-fuel data, a
// station with only bare (un-upgraded) fuel entries, and a station with an
// empty fuels list.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseStation, extractStationsArray } = require('../src/services/sberazsParser');
const sample = require('./fixtures/sberazsSample.json');

function byName(name) {
  const raw = extractStationsArray(sample).find((s) => s.name === name);
  assert.ok(raw, `fixture is missing a station named "${name}"`);
  return parseStation(raw);
}

test('extractStationsArray reads the wrapper object\'s stations list', () => {
  assert.equal(extractStationsArray(sample).length, 3);
});

test('parseStation: a station with per-fuel availabilityStatus produces matching fuelStatuses', () => {
  const parsed = byName('Лукойл');
  assert.equal(parsed.status, 'available'); // station-level, unaffected
  assert.deepEqual(parsed.fuelTypes.sort(), ['100', '92', '95', 'ДТ'].sort()); // still lists every carried type
  const byType = Object.fromEntries(parsed.fuelStatuses.map((f) => [f.fuelType, f.status]));
  assert.equal(byType['92'], 'available'); // available: true, availabilityStatus: "available"
  assert.equal(byType['95'], 'available');
  assert.equal(byType['100'], 'no_data'); // availabilityStatus: "unknown" -> no_data, not dropped
  assert.equal(byType['ДТ'], 'maybe_available'); // availabilityStatus: "stale" -> maybe_available, "diesel" normalized to "ДТ"
});

test('parseStation: a station with only bare (un-upgraded) fuel entries has no fuelStatuses', () => {
  const parsed = byName('У таксопарка');
  assert.equal(parsed.status, 'no_data');
  assert.deepEqual(parsed.fuelTypes.sort(), ['92', '95']); // still available for the old projection fallback
  assert.deepEqual(parsed.fuelStatuses, []); // no entry carries its own availabilityStatus key
});

test('parseStation: a station with an empty fuels list produces empty arrays, not an error', () => {
  const parsed = byName('Татнефть, АЗС');
  assert.deepEqual(parsed.fuelTypes, []);
  assert.deepEqual(parsed.fuelStatuses, []);
});
