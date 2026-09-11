const test = require('node:test');
const assert = require('node:assert/strict');
const { computeOutages, advanceOutageStreak, truncateToBucketStart } = require('../src/services/metricsService');

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

test('computeOutages: openStartedAt is null once every outage has recovered', () => {
  const history = [snap('not_available', '2026-01-01T00:00:00Z'), snap('available', '2026-01-01T01:00:00Z')];
  assert.equal(computeOutages(history).openStartedAt, null);
});

test('computeOutages: openStartedAt surfaces the trailing (censored) streak\'s own start', () => {
  const history = [snap('available', '2026-01-01T00:00:00Z'), snap('not_available', '2026-01-01T01:00:00Z')];
  assert.equal(computeOutages(history).openStartedAt.toISOString(), '2026-01-01T01:00:00.000Z');
});

// Feeds a history array through advanceOutageStreak one snapshot at a time
// (as ingestService.js's live hook would, one per ingest tick) instead of as
// one array (as computeOutages gets it) - the two are meant to agree
// byte-for-byte on the same input, see advanceOutageStreak's own doc
// comment.
function runStreak(history, regionId) {
  let openOutages = [];
  const closedOutages = [];
  for (const s of history) {
    const result = advanceOutageStreak(openOutages, regionId, s.status, s.polledAt);
    openOutages = result.openOutages;
    if (result.closedOutage) {
      const { start, end, durationMinutes } = result.closedOutage;
      closedOutages.push({ start, end, durationMinutes });
    }
  }
  return { closedOutages, openOutages };
}

test('advanceOutageStreak: matches computeOutages tick-by-tick for a single outage', () => {
  const history = [
    snap('available', '2026-01-01T10:00:00Z'),
    snap('not_available', '2026-01-01T11:00:00Z'),
    snap('not_available', '2026-01-01T12:00:00Z'),
    snap('available', '2026-01-01T13:30:00Z'),
  ];
  const { closedOutages } = runStreak(history, 'r1');
  assert.deepEqual(closedOutages, computeOutages(history).outages);
});

test('advanceOutageStreak: matches computeOutages for maybe_available recovery', () => {
  const history = [snap('not_available', '2026-01-01T00:00:00Z'), snap('maybe_available', '2026-01-01T01:00:00Z')];
  const { closedOutages } = runStreak(history, 'r1');
  assert.deepEqual(closedOutages, computeOutages(history).outages);
});

test('advanceOutageStreak: a trailing outage stays open (censored), not force-closed', () => {
  const history = [
    snap('available', '2026-01-01T00:00:00Z'),
    snap('not_available', '2026-01-01T01:00:00Z'),
    snap('not_available', '2026-01-01T02:00:00Z'),
  ];
  const { closedOutages, openOutages } = runStreak(history, 'r1');
  assert.deepEqual(closedOutages, []);
  assert.equal(openOutages.length, 1);
  assert.equal(openOutages[0].startedAt.toISOString(), '2026-01-01T01:00:00.000Z');
});

test('advanceOutageStreak: no_data mid-outage does not break the streak', () => {
  const history = [
    snap('not_available', '2026-01-01T00:00:00Z'),
    snap('no_data', '2026-01-01T00:30:00Z'),
    snap('available', '2026-01-01T01:00:00Z'),
  ];
  const { closedOutages } = runStreak(history, 'r1');
  assert.deepEqual(closedOutages, computeOutages(history).outages);
});

test('advanceOutageStreak: several outages in order all get recorded, matching computeOutages', () => {
  const history = [
    snap('not_available', '2026-01-01T00:00:00Z'),
    snap('available', '2026-01-01T00:10:00Z'),
    snap('available', '2026-01-01T05:00:00Z'),
    snap('not_available', '2026-01-01T06:00:00Z'),
    snap('available', '2026-01-01T06:20:00Z'),
  ];
  const { closedOutages } = runStreak(history, 'r1');
  assert.deepEqual(closedOutages, computeOutages(history).outages);
});

test('advanceOutageStreak: two regions for the same station track independent streaks', () => {
  // A station in two overlapping regions (Station.regions is an array) -
  // region A goes down and recovers; region B is untouched throughout and
  // must not see a streak it never had, even though both share one
  // `openOutages` array on the Station document in production.
  let openOutages = [];
  let a = advanceOutageStreak(openOutages, 'regionA', 'not_available', new Date('2026-01-01T00:00:00Z'));
  openOutages = a.openOutages;
  assert.equal(a.closedOutage, null);
  assert.deepEqual(openOutages, [{ region: 'regionA', startedAt: new Date('2026-01-01T00:00:00Z') }]);

  // region B's own tick, same station, arrives before region A recovers -
  // must not touch region A's open entry or spuriously open its own.
  const b = advanceOutageStreak(openOutages, 'regionB', 'available', new Date('2026-01-01T00:05:00Z'));
  assert.equal(b.closedOutage, null);
  assert.deepEqual(b.openOutages, openOutages);

  const aRecovered = advanceOutageStreak(openOutages, 'regionA', 'available', new Date('2026-01-01T01:00:00Z'));
  assert.deepEqual(aRecovered.closedOutage, {
    region: 'regionA',
    start: new Date('2026-01-01T00:00:00Z'),
    end: new Date('2026-01-01T01:00:00Z'),
    durationMinutes: 60,
  });
  assert.deepEqual(aRecovered.openOutages, []);
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
