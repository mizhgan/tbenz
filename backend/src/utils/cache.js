/**
 * Wraps an async function with a TTL cache that also dedupes concurrent
 * calls sharing the same key (an in-flight call is awaited and reused
 * rather than re-run) - needed because the reports page fires several
 * requests in parallel that internally call the same underlying query
 * with identical arguments.
 */
function memoizeAsync(fn, { ttlMs, keyFn }) {
  const entries = new Map(); // key -> { expiresAt, promise }

  async function wrapped(...args) {
    const key = keyFn(...args);
    const now = Date.now();
    const existing = entries.get(key);
    if (existing && existing.expiresAt > now) {
      return existing.promise;
    }

    const promise = Promise.resolve().then(() => fn(...args));
    entries.set(key, { expiresAt: now + ttlMs, promise });
    promise.catch(() => entries.delete(key));
    return promise;
  }

  return wrapped;
}

module.exports = { memoizeAsync };
