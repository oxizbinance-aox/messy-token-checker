// src/ai/timing.js — Per-phase timing log for the AI path (round 3).
//
// The cloud AI call started timing out (3/3 live failures, 26 Nov 2026,
// each burning the full 90s) after succeeding twice the same day. The
// generateContent call is a black box from the app's side: inside it the
// SDK (a) fetches an App Check token (reCAPTCHA Enterprise execute +
// token exchange) and (b) POSTs to the Generative Language API. Either
// phase can be the stall, and the 90s wrapper cannot tell them apart.
// So every AI phase logs one console line with a shared `[ai-timing]`
// prefix and a per-check label:
//
//   [ai-timing check#7] runAi start mode=cloud-only +0ms
//   [ai-timing check#7] appcheck:getToken start +3ms
//   [ai-timing check#7] appcheck:getToken ok +1234ms (token expires in 3599s)
//   [ai-timing check#7] model:create cloud-only +1236ms
//   [ai-timing check#7] generateContent start +1237ms
//   [ai-timing check#7] generateContent ok +9123ms route=in_cloud
//   [ai-timing check#7] runAi done +9125ms route=IN_CLOUD
//
// Console-only, harmless, SHIPPED on purpose: the parent's live browser
// re-test reads these lines from DevTools console to decide which phase
// hangs. console.log (not console.debug) so the lines show at the
// default DevTools log level. No PII, no token values, no prompt text.

/**
 * Start a per-check timer.
 * @param {string} label — e.g. "check#7" or "retry"
 * @returns {{ mark: (name: string, extra?: string) => number }}
 */
export function createAiTimer(label) {
  const hasPerf =
    typeof performance !== "undefined" &&
    typeof performance.now === "function";
  const t0 = hasPerf ? performance.now() : Date.now();
  const now = () =>
    Math.round((hasPerf ? performance.now() : Date.now()) - t0);
  return {
    mark(name, extra = "") {
      const ms = now();
      console.log(
        `[ai-timing ${label}] ${name} +${ms}ms${extra ? ` ${extra}` : ""}`,
      );
      return ms;
    },
  };
}
