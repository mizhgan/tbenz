const test = require('node:test');
const assert = require('node:assert/strict');
const { computeOutages } = require('../src/services/metricsService');

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
