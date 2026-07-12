const test = require('node:test');
const assert = require('node:assert/strict');
const { chatMatchesFilters } = require('../src/services/telegramNotifier');

function chat(overrides) {
  return { watchlist: [], fuelTypes: [], brands: [], ...overrides };
}

function station(overrides) {
  return { _id: 'station-1', name: 'Лукойл', ...overrides };
}

test('chatMatchesFilters: unconfigured fuelTypes (empty array) defaults to gasoline (92/95), not "all"', () => {
  const c = chat({});
  assert.equal(chatMatchesFilters(c, station(), '92'), true);
  assert.equal(chatMatchesFilters(c, station(), '95'), true);
  assert.equal(chatMatchesFilters(c, station(), 'ДТ'), false); // diesel - not core anymore
  assert.equal(chatMatchesFilters(c, station(), '100'), false); // premium grade - not core
  assert.equal(chatMatchesFilters(c, station(), 'propane'), false);
});

test('chatMatchesFilters: an explicit fuelTypes list overrides the gasoline default entirely', () => {
  const c = chat({ fuelTypes: ['propane'] });
  assert.equal(chatMatchesFilters(c, station(), 'propane'), true);
  assert.equal(chatMatchesFilters(c, station(), '92'), false); // not in the explicit list
});

test('chatMatchesFilters: a watchlisted station bypasses the fuel-type filter entirely, even for non-core types', () => {
  const c = chat({ watchlist: ['station-1'] });
  assert.equal(chatMatchesFilters(c, station({ _id: 'station-1' }), 'propane'), true);
});

test('chatMatchesFilters: brands filter still applies on top of the gasoline default', () => {
  const c = chat({ brands: ['Роснефть'] });
  assert.equal(chatMatchesFilters(c, station({ name: 'Лукойл' }), '92'), false);
  assert.equal(chatMatchesFilters(c, station({ name: 'Роснефть' }), '92'), true);
});
