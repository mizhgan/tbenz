const test = require('node:test');
const assert = require('node:assert/strict');
const { linearRegression, blendHourForecast } = require('../src/services/forecastService');

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

// 2026-01-01T09:00:00Z is 12:00 in Europe/Moscow (UTC+3) - used below so
// hourProfile.get(12) is the cell blendHourForecast will actually look up.
const AT = new Date('2026-01-01T09:00:00Z');
const TZ = 'Europe/Moscow';
const FLAT_TREND = { slope: 0, intercept: 90 }; // trendPct = 90 regardless of x

test('blendHourForecast: hour 1 (blend weight 1) is pure trend, ignoring the profile entirely', () => {
  const hourProfile = new Map([[12, { availablePct: 10, samples: 10 }]]);
  const result = blendHourForecast({ i: 1, x: 0, shortReg: FLAT_TREND, hourProfile, overallAvailablePct: 50, at: AT, tz: TZ });
  assert.equal(result.basis, 'trend');
  assert.equal(result.availablePct, 90);
});

test('blendHourForecast: hour past TREND_BLEND_HOURS (weight 0) is pure hour-of-day profile', () => {
  const hourProfile = new Map([[12, { availablePct: 10, samples: 10 }]]);
  const result = blendHourForecast({ i: 4, x: 3, shortReg: FLAT_TREND, hourProfile, overallAvailablePct: 50, at: AT, tz: TZ });
  assert.equal(result.basis, 'hour-profile');
  assert.equal(result.availablePct, 10);
});

test('blendHourForecast: an hour strictly between is a weighted blend of both signals', () => {
  const hourProfile = new Map([[12, { availablePct: 10, samples: 10 }]]);
  const result = blendHourForecast({ i: 2, x: 1, shortReg: FLAT_TREND, hourProfile, overallAvailablePct: 50, at: AT, tz: TZ });
  assert.equal(result.basis, 'trend+hour-profile');
  // blendWeight at i=2 is 1 - 1/3 = 2/3 -> 90*(2/3) + 10*(1/3) = 63.33...
  assert.ok(Math.abs(result.availablePct - 63.333) < 0.01);
});

test('blendHourForecast: a thin profile cell (below MIN_HOUR_PROFILE_SAMPLES) falls back to the overall average', () => {
  const hourProfile = new Map([[12, { availablePct: 10, samples: 1 }]]); // below the threshold of 3
  const result = blendHourForecast({ i: 10, x: 9, shortReg: null, hourProfile, overallAvailablePct: 42, at: AT, tz: TZ });
  assert.equal(result.basis, 'flat-average');
  assert.equal(result.availablePct, 42);
});

test('blendHourForecast: no trend and no profile cell at all falls back cleanly to no-data', () => {
  const result = blendHourForecast({ i: 5, x: 4, shortReg: null, hourProfile: new Map(), overallAvailablePct: null, at: AT, tz: TZ });
  assert.equal(result.basis, 'no-data');
  assert.equal(result.availablePct, null);
});

test('blendHourForecast: no trend but a real profile cell uses the profile straight away, even at hour 1', () => {
  const hourProfile = new Map([[12, { availablePct: 77, samples: 5 }]]);
  const result = blendHourForecast({ i: 1, x: 0, shortReg: null, hourProfile, overallAvailablePct: 50, at: AT, tz: TZ });
  assert.equal(result.basis, 'hour-profile');
  assert.equal(result.availablePct, 77);
});

test('blendHourForecast: a trend value is clamped to [0, 100] before blending', () => {
  const wildTrend = { slope: 1000, intercept: 0 }; // would produce a huge yRaw at x=5
  const result = blendHourForecast({ i: 1, x: 5, shortReg: wildTrend, hourProfile: new Map(), overallAvailablePct: null, at: AT, tz: TZ });
  assert.equal(result.availablePct, 100);
});
