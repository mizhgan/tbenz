const test = require('node:test');
const assert = require('node:assert/strict');
const { coreStatus } = require('../src/services/telegramPredictiveAlerts');

test('coreStatus: best-of among 92/95/ДТ, ignoring non-core types', () => {
  assert.equal(
    coreStatus([
      { fuelType: '92', status: 'not_available' },
      { fuelType: '95', status: 'available' },
      { fuelType: 'ДТ', status: 'no_data' },
      { fuelType: 'propane', status: 'available' }, // ignored - not core-3
    ]),
    'available'
  );
});

test('coreStatus: not_available only wins when nothing better is present', () => {
  assert.equal(
    coreStatus([
      { fuelType: '92', status: 'not_available' },
      { fuelType: '95', status: 'not_available' },
      { fuelType: 'ДТ', status: 'no_data' },
    ]),
    'no_data'
  );
});

test('coreStatus: a station with no core-3 reading at all is no_data (propane-only AGZS)', () => {
  assert.equal(coreStatus([{ fuelType: 'propane', status: 'available' }]), 'no_data');
});

test('coreStatus: empty/missing fuelStatuses is no_data, not a crash', () => {
  assert.equal(coreStatus([]), 'no_data');
  assert.equal(coreStatus(undefined), 'no_data');
});

test('coreStatus: maybe_available beats no_data and not_available, loses to available', () => {
  assert.equal(
    coreStatus([
      { fuelType: '92', status: 'maybe_available' },
      { fuelType: '95', status: 'not_available' },
    ]),
    'maybe_available'
  );
  assert.equal(
    coreStatus([
      { fuelType: '92', status: 'maybe_available' },
      { fuelType: '95', status: 'available' },
    ]),
    'available'
  );
});
