/**
 * Shared HTTP / timeout helpers — Messy Token Checker.
 *
 * The live test (26 Nov 2026) proved why these exist: a BRETT check hung
 * at "Checking…" for 3.5+ minutes with no timeout, no error and no way to
 * cancel, because every `fetch()` in the app was unbounded. Every network
 * hop in the app now goes through one of these helpers so no single stall
 * can freeze the check forever.
 */

/** Thrown when a bounded wait expires (fetch timeout or promise timeout). */
export class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * `fetch()` with a hard timeout and an optional external abort signal.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=20000] — abort the request after this long
 * @param {AbortSignal} [opts.signal] — external signal (e.g. the check's
 *   Cancel button); aborting it rejects with the original AbortError
 * @returns {Promise<Response>}
 * @throws {TimeoutError} when the timeout fires
 * @throws {DOMException} (AbortError) when the external signal aborts
 */
export async function fetchWithTimeout(url, { timeoutMs = 20000, signal } = {}) {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      // Already cancelled — fail fast instead of starting a doomed request.
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      throw new TimeoutError(
        `Request to ${url} timed out after ${timeoutMs / 1000}s`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Race a promise against a timeout. Used for calls that take no signal
 * (e.g. Firebase AI Logic generateContent) so they can't hang forever.
 *
 * @param {Promise} promise
 * @param {number} ms
 * @param {string} [message]
 * @returns {Promise} the promise's value, or rejects with TimeoutError
 */
export function withTimeout(promise, ms, message = `Operation timed out after ${ms / 1000}s`) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
