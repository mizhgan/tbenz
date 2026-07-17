import { ref } from 'vue';

// The one shape every admin view's hand-rolled try/catch already agreed on
// (verified across ~35 call sites before writing this): the backend's error
// middleware always puts the user-facing message at `err.response.data.error`
// (never `.data.message` - that key isn't used anywhere in this API), so a
// bare axios error falls back to the call site's own Russian message.
function defaultFormatError(err, fallbackMessage) {
  return err.response?.data?.error || fallbackMessage;
}

/**
 * Single-flight async action state: `loading`/`error` refs plus a `run`
 * that wraps a call in the same try/loading/catch/finally shape every admin
 * view previously duplicated by hand. Call `useAsyncAction()` once per
 * component and reuse the returned `run` for each of that component's
 * actions (submit, delete, ...) if they're meant to share one error slot -
 * same as the single `errorMessage` ref most views already reused across
 * handleSubmit/handleDelete before this existed. Give each action its own
 * `useAsyncAction()` instance instead if they need independent state.
 *
 * `run`'s return value is `undefined` on failure (the error already landed
 * in `error.value`) rather than a rethrow - every existing call site either
 * ignored the thrown error entirely (relying on `error.value` for display)
 * or needed a chance to react via `onError` (e.g. StationMatchingView's
 * optimistic-splice rollback), which is what `onError` is for below.
 *
 * `formatError` lets a call site opt out of the default `data.error`
 * extraction - needed by the Clipboard/Web Share API call sites, which
 * throw plain client-side errors with no `.response` at all and want a
 * different message prefix (or, for a cancelled share sheet, no error at
 * all - return a falsy value from `formatError` to suppress it).
 */
export function useAsyncAction() {
  const loading = ref(false);
  const error = ref('');

  async function run(fn, { fallbackMessage = 'Что-то пошло не так', formatError = defaultFormatError, onError } = {}) {
    loading.value = true;
    error.value = '';
    try {
      return await fn();
    } catch (err) {
      const message = formatError(err, fallbackMessage);
      if (message) error.value = message;
      if (onError) onError(err);
      return undefined;
    } finally {
      loading.value = false;
    }
  }

  return { loading, error, run };
}

/**
 * Same as `useAsyncAction`, but for the per-row "busy while this one item's
 * request is in flight" shape (StationMatchingView's match/ignore buttons,
 * ProxiesView's per-proxy check/toggle, TelegramView's per-chat test send) -
 * several keys can be in flight at once, each independently. `busyIds` is a
 * plain `Set` (not an array) so templates can keep using
 * `busyIds.has(someId)` exactly as they did with the hand-rolled version.
 */
export function useKeyedAsyncAction() {
  const busyIds = ref(new Set());
  const error = ref('');

  async function run(key, fn, { fallbackMessage = 'Что-то пошло не так', formatError = defaultFormatError, onError } = {}) {
    busyIds.value.add(key);
    error.value = '';
    try {
      return await fn();
    } catch (err) {
      const message = formatError(err, fallbackMessage);
      if (message) error.value = message;
      if (onError) onError(err);
      return undefined;
    } finally {
      busyIds.value.delete(key);
    }
  }

  return { busyIds, error, run };
}
