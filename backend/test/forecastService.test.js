const test = require('node:test');
const assert = require('node:assert/strict');
const { linearRegression } = require('../src/services/forecastService');

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
