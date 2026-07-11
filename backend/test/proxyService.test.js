const test = require('node:test');
const assert = require('node:assert/strict');
const { isBrowserCompatible } = require('../src/services/proxyService');

test('isBrowserCompatible: http/https are always fine, with or without credentials', () => {
  assert.equal(isBrowserCompatible({ type: 'http', username: '' }), true);
  assert.equal(isBrowserCompatible({ type: 'http', username: 'user' }), true);
  assert.equal(isBrowserCompatible({ type: 'https', username: 'user' }), true);
});

test('isBrowserCompatible: socks5 is only fine without credentials - Chromium can\'t authenticate to it at all', () => {
  assert.equal(isBrowserCompatible({ type: 'socks5', username: '' }), true);
  assert.equal(isBrowserCompatible({ type: 'socks5', username: null }), true);
  assert.equal(isBrowserCompatible({ type: 'socks5', username: 'user' }), false);
});
