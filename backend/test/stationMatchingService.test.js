const test = require('node:test');
const assert = require('node:assert/strict');
const { haversineMeters, nameSimilarity } = require('../src/services/stationMatchingService');

test('haversineMeters: same point is zero distance', () => {
  assert.equal(haversineMeters(58.0, 49.0, 58.0, 49.0), 0);
});

test('haversineMeters: one degree of latitude is ~111.2km, independent of longitude', () => {
  const meters = haversineMeters(0, 0, 1, 0);
  assert.ok(Math.abs(meters - 111194.9) < 1, `expected ~111194.9m, got ${meters}`);
});

test('haversineMeters: one degree of longitude at the equator matches one degree of latitude', () => {
  const meters = haversineMeters(0, 0, 0, 1);
  assert.ok(Math.abs(meters - 111194.9) < 1, `expected ~111194.9m, got ${meters}`);
});

test('nameSimilarity: identical names (case-insensitive) score 1', () => {
  assert.equal(nameSimilarity('Лукойл', 'лукойл'), 1);
});

test('nameSimilarity: one name containing the other scores 0.7 (common "АЗС №N" suffix case)', () => {
  assert.equal(nameSimilarity('АЗС Лукойл №5', 'Лукойл'), 0.7);
});

test('nameSimilarity: partial word overlap scores intersection/union, not 0 or 1', () => {
  // wordsA = {газпромнефть, 3, кировская}, wordsB = {кировская, азс, 3}
  // intersection = {3, кировская} = 2, union = 4 -> 0.5. Neither name
  // contains the other as a substring, so this exercises the word-overlap
  // branch specifically, not the "one includes the other" shortcut above.
  assert.equal(nameSimilarity('Газпромнефть №3 Кировская', 'Кировская АЗС №3'), 0.5);
});

test('nameSimilarity: no word overlap at all scores 0', () => {
  assert.equal(nameSimilarity('Роснефть', 'Лукойл'), 0);
});

test('nameSimilarity: empty or missing names score 0, not a crash', () => {
  assert.equal(nameSimilarity('', 'Лукойл'), 0);
  assert.equal(nameSimilarity(undefined, undefined), 0);
});
