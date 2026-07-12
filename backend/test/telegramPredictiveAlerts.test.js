const test = require('node:test');
const assert = require('node:assert/strict');
const { coreStatus } = require('../src/services/telegramPredictiveAlerts');

test('coreStatus: best-of among 92/95 (gasoline only), ignoring diesel/gas', () => {
  assert.equal(
    coreStatus([
      { fuelType: '92', status: 'not_available' },
      { fuelType: '95', status: 'available' },
      { fuelType: 'ДТ', status: 'not_available' }, // ignored - diesel is not core
      { fuelType: 'propane', status: 'available' }, // ignored - not core either
    ]),
    'available'
  );
});

test('coreStatus: not_available wins when nothing better is present among 92/95', () => {
  assert.equal(
    coreStatus([
      { fuelType: '92', status: 'not_available' },
      { fuelType: '95', status: 'not_available' },
      { fuelType: 'ДТ', status: 'available' }, // ignored - diesel being available doesn't help
    ]),
    'not_available'
  );
});

test('coreStatus: a station with no 92/95 reading at all is no_data (diesel/propane-only station)', () => {
  assert.equal(coreStatus([{ fuelType: 'ДТ', status: 'available' }]), 'no_data');
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
