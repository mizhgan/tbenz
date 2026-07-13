const test = require('node:test');
const assert = require('node:assert/strict');
const { memoizeAsync } = require('../src/utils/cache');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('memoizeAsync: a second call within the TTL reuses the cached result, not a fresh call', async () => {
  let calls = 0;
  const fn = memoizeAsync(
    async (id) => {
      calls += 1;
      return `value-${id}`;
    },
    { ttlMs: 10_000, keyFn: (id) => id }
  );

  assert.equal(await fn('a'), 'value-a');
  assert.equal(await fn('a'), 'value-a');
  assert.equal(calls, 1);
});

test('memoizeAsync: a call after the TTL expires re-runs the underlying function', async () => {
  let calls = 0;
  const fn = memoizeAsync(
    async () => {
      calls += 1;
      return calls;
    },
    { ttlMs: 20, keyFn: () => 'k' }
  );

  assert.equal(await fn(), 1);
  await delay(30);
  assert.equal(await fn(), 2);
});

test('memoizeAsync: concurrent calls sharing a key dedupe into one in-flight run', async () => {
  let calls = 0;
  const fn = memoizeAsync(
    async () => {
      calls += 1;
      await delay(10);
      return 'result';
    },
    { ttlMs: 10_000, keyFn: () => 'k' }
  );

  const [a, b] = await Promise.all([fn(), fn()]);
  assert.equal(a, 'result');
  assert.equal(b, 'result');
  assert.equal(calls, 1);
});

test('memoizeAsync: a rejected call is not cached - the next call retries instead of re-throwing forever', async () => {
  let calls = 0;
  const fn = memoizeAsync(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return 'recovered';
    },
    { ttlMs: 10_000, keyFn: () => 'k' }
  );

  await assert.rejects(fn(), /boom/);
  assert.equal(await fn(), 'recovered');
  assert.equal(calls, 2);
});

test('memoizeAsync: different keys are cached independently', async () => {
  let calls = 0;
  const fn = memoizeAsync(
    async (id) => {
      calls += 1;
      return id;
    },
    { ttlMs: 10_000, keyFn: (id) => id }
  );

  await fn('a');
  await fn('b');
  await fn('a');
  assert.equal(calls, 2);
});
