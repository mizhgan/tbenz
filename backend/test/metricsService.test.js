const test = require('node:test');
const assert = require('node:assert/strict');
const { computeOutages, truncateToBucketStart } = require('../src/services/metricsService');

function snap(status, isoTime) {
  return { status, polledAt: new Date(isoTime) };
}

test('computeOutages: a single outage produces one outage record with the right duration', () => {
  const history = [
    snap('available', '2026-01-01T10:00:00Z'),
    snap('not_available', '2026-01-01T11:00:00Z'),
    snap('not_available', '2026-01-01T12:00:00Z'),
    snap('available', '2026-01-01T13:30:00Z'),
  ];
  const { outageCount, avgOutageMinutes, outages } = computeOutages(history);
  assert.equal(outageCount, 1);
  assert.equal(avgOutageMinutes, 150); // 11:00 -> 13:30 = 2.5h
  assert.deepEqual(outages, [
    { start: new Date('2026-01-01T11:00:00Z'), end: new Date('2026-01-01T13:30:00Z'), durationMinutes: 150 },
  ]);
});

test('computeOutages: maybe_available also counts as recovery, same as available', () => {
  const history = [snap('not_available', '2026-01-01T00:00:00Z'), snap('maybe_available', '2026-01-01T01:00:00Z')];
  const { outages } = computeOutages(history);
  assert.equal(outages.length, 1);
  assert.equal(outages[0].durationMinutes, 60);
});

test('computeOutages: a trailing outage that never recovers is excluded (censored data)', () => {
  const history = [
    snap('available', '2026-01-01T00:00:00Z'),
    snap('not_available', '2026-01-01T01:00:00Z'),
    snap('not_available', '2026-01-01T02:00:00Z'),
  ];
  const { outageCount, avgOutageMinutes, outages } = computeOutages(history);
  assert.equal(outageCount, 0);
  assert.equal(avgOutageMinutes, null);
  assert.deepEqual(outages, []);
});

test('computeOutages: no_data mid-outage does not break the streak, still counts once recovered', () => {
  const history = [
    snap('not_available', '2026-01-01T00:00:00Z'),
    snap('no_data', '2026-01-01T00:30:00Z'),
    snap('available', '2026-01-01T01:00:00Z'),
  ];
  const { outages } = computeOutages(history);
  assert.equal(outages.length, 1);
  assert.equal(outages[0].start.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(outages[0].end.toISOString(), '2026-01-01T01:00:00.000Z');
});

test('computeOutages: several outages in order all get recorded', () => {
  const history = [
    snap('not_available', '2026-01-01T00:00:00Z'),
    snap('available', '2026-01-01T00:10:00Z'),
    snap('available', '2026-01-01T05:00:00Z'),
    snap('not_available', '2026-01-01T06:00:00Z'),
    snap('available', '2026-01-01T06:20:00Z'),
  ];
  const { outageCount, outages } = computeOutages(history);
  assert.equal(outageCount, 2);
  assert.equal(outages[0].durationMinutes, 10);
  assert.equal(outages[1].durationMinutes, 20);
});

test('truncateToBucketStart: hour buckets floor to the top of the hour', () => {
  const result = truncateToBucketStart(new Date('2026-01-01T10:37:00Z'), 'hour', 1);
  assert.equal(result.toISOString(), '2026-01-01T10:00:00.000Z');
});

test('truncateToBucketStart: a multi-hour bin (e.g. 3h) floors to the nearest bucket boundary in Moscow local time', () => {
  // 10:37 UTC = 13:37 Moscow (UTC+3) -> floor(13/3)*3 = 12 local -> 09:00 UTC.
  const result = truncateToBucketStart(new Date('2026-01-01T10:37:00Z'), 'hour', 3);
  assert.equal(result.toISOString(), '2026-01-01T09:00:00.000Z');
});

test('truncateToBucketStart: day buckets use the Moscow-local day boundary, not UTC midnight', () => {
  // 22:30 UTC on Jan 1 = 01:30 Moscow on Jan 2 -> local day start is Jan 2
  // 00:00 Moscow = Jan 1 21:00 UTC, not Jan 1 00:00 UTC. This is the exact
  // behavior getRecoveryTrend's own doc comment says was already found
  // buggy once (bucket count not matching getAvailabilityTrend's) before
  // this function existed.
  const result = truncateToBucketStart(new Date('2026-01-01T22:30:00Z'), 'day', 1);
  assert.equal(result.toISOString(), '2026-01-01T21:00:00.000Z');
});

test('truncateToBucketStart: idempotent - truncating an already-truncated instant is a no-op', () => {
  const once = truncateToBucketStart(new Date('2026-01-01T22:30:00Z'), 'day', 1);
  const twice = truncateToBucketStart(once, 'day', 1);
  assert.equal(once.toISOString(), twice.toISOString());
});
