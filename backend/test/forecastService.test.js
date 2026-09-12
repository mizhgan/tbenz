const test = require('node:test');
const assert = require('node:assert/strict');
const {
  linearRegression,
  blendHourForecast,
  currentCoreStatusToPct,
  resolveBucketsAhead,
} = require('../src/services/forecastService');

test('resolveBucketsAhead: an explicit value always wins, regardless of history length', () => {
  assert.equal(resolveBucketsAhead(10, 7), 10);
  assert.equal(resolveBucketsAhead(1, 400), 1);
});

test('resolveBucketsAhead: a short history (the reports page\'s own default 7-day period) is floored, not left at the old flat 6', () => {
  // ceil(7 * 0.2) = 2, which is also the MIN - so 2, not the old fixed 6
  // that used to be ~half of a 7-bucket chart.
  assert.equal(resolveBucketsAhead(undefined, 7), 2);
});

test('resolveBucketsAhead: a long history is capped at the old 6-bucket default, not left growing with the fraction', () => {
  // ceil(90 * 0.2) = 18, capped down to MAX = 6
  assert.equal(resolveBucketsAhead(undefined, 90), 6);
});

test('resolveBucketsAhead: scales in between the floor and cap for a mid-length history', () => {
  // ceil(20 * 0.2) = 4
  assert.equal(resolveBucketsAhead(undefined, 20), 4);
});

test('linearRegression: recovers slope/intercept exactly for a perfect line', () => {
  const points = [
    { x: 0, y: 1 },
    { x: 1, y: 3 },
    { x: 2, y: 5 },
  ];
  const result = linearRegression(points);
  assert.ok(Math.abs(result.slope - 2) < 1e-9);
  assert.ok(Math.abs(result.intercept - 1) < 1e-9);
});

test('linearRegression: non-finite y values (a bucket with no known data) are excluded, not treated as 0', () => {
  const withGap = linearRegression([
    { x: 0, y: 1 },
    { x: 1, y: NaN },
    { x: 2, y: 5 },
  ]);
  const withoutGap = linearRegression([
    { x: 0, y: 1 },
    { x: 2, y: 5 },
  ]);
  assert.deepEqual(withGap, withoutGap);
});

test('linearRegression: fewer than 2 valid points returns null, not a divide-by-zero result', () => {
  assert.equal(linearRegression([]), null);
  assert.equal(linearRegression([{ x: 0, y: 1 }]), null);
  assert.equal(linearRegression([{ x: 0, y: NaN }, { x: 1, y: 2 }]), null);
});

test('linearRegression: every point at the same x is a degenerate (vertical) case, returns null', () => {
  assert.equal(
    linearRegression([
      { x: 5, y: 1 },
      { x: 5, y: 9 },
    ]),
    null
  );
});

test('currentCoreStatusToPct: available and maybe_available both map to 100, same pooling as metricsService withKnownPct', () => {
  assert.equal(currentCoreStatusToPct('available'), 100);
  assert.equal(currentCoreStatusToPct('maybe_available'), 100);
});

test('currentCoreStatusToPct: not_available maps to 0, no_data has no anchor at all', () => {
  assert.equal(currentCoreStatusToPct('not_available'), 0);
  assert.equal(currentCoreStatusToPct('no_data'), null);
});

// 2026-01-01T09:00:00Z is 12:00 in Europe/Moscow (UTC+3) - used below so
// hourProfile.get(12) is the cell blendHourForecast will actually look up.
const AT = new Date('2026-01-01T09:00:00Z');
const TZ = 'Europe/Moscow';
const FLAT_SLOPE = { slope: 0 }; // trendPct stays at currentAnchorPct for every i

test('blendHourForecast: hour 1 (blend weight 1) is pure anchored trend, ignoring the profile entirely', () => {
  const hourProfile = new Map([[12, { availablePct: 10, samples: 10 }]]);
  const result = blendHourForecast({
    i: 1,
    currentAnchorPct: 90,
    shortReg: FLAT_SLOPE,
    hourProfile,
    overallAvailablePct: 50,
    at: AT,
    tz: TZ,
  });
  assert.equal(result.basis, 'trend');
  assert.equal(result.availablePct, 90);
});

test('blendHourForecast: hour past TREND_BLEND_HOURS (weight 0) is pure hour-of-day profile', () => {
  const hourProfile = new Map([[12, { availablePct: 10, samples: 10 }]]);
  const result = blendHourForecast({
    i: 4,
    currentAnchorPct: 90,
    shortReg: FLAT_SLOPE,
    hourProfile,
    overallAvailablePct: 50,
    at: AT,
    tz: TZ,
  });
  assert.equal(result.basis, 'hour-profile');
  assert.equal(result.availablePct, 10);
});

test('blendHourForecast: an hour strictly between is a weighted blend of both signals', () => {
  const hourProfile = new Map([[12, { availablePct: 10, samples: 10 }]]);
  const result = blendHourForecast({
    i: 2,
    currentAnchorPct: 90,
    shortReg: FLAT_SLOPE,
    hourProfile,
    overallAvailablePct: 50,
    at: AT,
    tz: TZ,
  });
  assert.equal(result.basis, 'trend+hour-profile');
  // blendWeight at i=2 is 1 - 1/3 = 2/3 -> 90*(2/3) + 10*(1/3) = 63.33...
  assert.ok(Math.abs(result.availablePct - 63.333) < 0.01);
});

test('blendHourForecast: a thin profile cell (below MIN_HOUR_PROFILE_SAMPLES) falls back to the overall average', () => {
  const hourProfile = new Map([[12, { availablePct: 10, samples: 1 }]]); // below the threshold of 3
  const result = blendHourForecast({
    i: 10,
    currentAnchorPct: null,
    shortReg: null,
    hourProfile,
    overallAvailablePct: 42,
    at: AT,
    tz: TZ,
  });
  assert.equal(result.basis, 'flat-average');
  assert.equal(result.availablePct, 42);
});

test('blendHourForecast: nothing to anchor to and no profile cell at all falls back cleanly to no-data', () => {
  const result = blendHourForecast({
    i: 5,
    currentAnchorPct: null,
    shortReg: null,
    hourProfile: new Map(),
    overallAvailablePct: null,
    at: AT,
    tz: TZ,
  });
  assert.equal(result.basis, 'no-data');
  assert.equal(result.availablePct, null);
});

test('blendHourForecast: no known current status (no_data) but a real profile cell uses the profile straight away, even at hour 1', () => {
  const hourProfile = new Map([[12, { availablePct: 77, samples: 5 }]]);
  const result = blendHourForecast({
    i: 1,
    currentAnchorPct: null,
    shortReg: null,
    hourProfile,
    overallAvailablePct: 50,
    at: AT,
    tz: TZ,
  });
  assert.equal(result.basis, 'hour-profile');
  assert.equal(result.availablePct, 77);
});

test('blendHourForecast: an anchored trend value is clamped to [0, 100]', () => {
  const steepSlope = { slope: 1000 };
  const result = blendHourForecast({
    i: 1,
    currentAnchorPct: 50,
    shortReg: steepSlope,
    hourProfile: new Map(),
    overallAvailablePct: null,
    at: AT,
    tz: TZ,
  });
  assert.equal(result.availablePct, 100);
});

test('blendHourForecast: the trend is anchored to the current status and shaped by slope only - the regression\'s own intercept is ignored', () => {
  // A regression fit over history might have an intercept far from the
  // station's actual current reading (e.g. it was mostly unavailable
  // earlier in the window) - only its slope (rate of change) should matter
  // once anchored to what's actually true right now.
  const regressionWithUnrelatedIntercept = { slope: 5, intercept: 999 };
  const result = blendHourForecast({
    i: 2,
    currentAnchorPct: 0,
    shortReg: regressionWithUnrelatedIntercept,
    hourProfile: new Map(),
    overallAvailablePct: null,
    at: AT,
    tz: TZ,
  });
  assert.equal(result.basis, 'trend');
  assert.equal(result.availablePct, 10); // 0 + 5*2, not anywhere near 999
});

test('blendHourForecast: a known current status with no short-window regression yet is a flat continuation (basis "current")', () => {
  const result = blendHourForecast({
    i: 3,
    currentAnchorPct: 70,
    shortReg: null,
    hourProfile: new Map(),
    overallAvailablePct: null,
    at: AT,
    tz: TZ,
  });
  assert.equal(result.basis, 'current');
  assert.equal(result.availablePct, 70);
});
