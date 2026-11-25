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
//
// ROUND 4 (26 Nov 2026): the cloud browser used for live re-tests
// CANNOT open DevTools at all (Ctrl+Shift+J / Ctrl+Shift+I / Inspect
// all fail to show the panel), so the console lines were unreadable
// and the round-3 re-test captured ZERO timings. The timer now also
// RECORDS every line in memory (timer.lines), and buildAiDiagnostics()
// snapshots them into a plain object the UI renders in a collapsed
// "AI diagnostics" block inside the AI card — readable by any browser
// test, no DevTools needed. The console logging is unchanged.

/**
 * Start a per-check timer.
 * @param {string} label — e.g. "check#7" or "retry"
 * @returns {{ label: string, lines: string[], mark: (name: string, extra?: string) => number }}
 */
export function createAiTimer(label) {
  const hasPerf =
    typeof performance !== "undefined" &&
    typeof performance.now === "function";
  const t0 = hasPerf ? performance.now() : Date.now();
  const now = () =>
    Math.round((hasPerf ? performance.now() : Date.now()) - t0);
  /** Every line mark() logs, kept in order for the on-page diagnostics. */
  const lines = [];
  return {
    label,
    lines,
    mark(name, extra = "") {
      const ms = now();
      const line = `[ai-timing ${label}] ${name} +${ms}ms${extra ? ` ${extra}` : ""}`;
      lines.push(line);
      console.log(line);
      return ms;
    },
  };
}

/**
 * Extract the phase name from one recorded timing line.
 * "[ai-timing check#7] generateContent start +1237ms" → "generateContent".
 * "[ai-timing check#7] appcheck:getToken start +3ms" → "appcheck:getToken".
 * "[ai-timing check#7] model:create cloud-only +1236ms" → "model:create".
 * Returns null when the line does not match the timing format.
 */
export function phaseOfLine(line) {
  if (typeof line !== "string") return null;
  const m = line.match(/\] (.+?) \+\d+ms/);
  if (!m) return null;
  return m[1].split(" ")[0] || null;
}

/**
 * Snapshot one AI attempt's diagnostics for the on-page block (round 4).
 * Pure function — no DOM, no console — so Node smoke tests can cover it.
 *
 * @param {{ label?: string, lines?: string[] } | null} timer — the
 *   createAiTimer() of this attempt, or null when no AI attempt ran
 *   (prompt build failed / model missing).
 * @param {object} [opts]
 * @param {string|null} [opts.mode] — "cloud-only" | "hybrid"
 * @param {string} [opts.outcome] — "ok" | "error" | "skipped"
 * @param {string|null} [opts.error] — raw error message, if the attempt failed
 * @param {string|null} [opts.probeLine] — the "[ai-timing probe] ..." line
 *   for this check's Nano probe, if it resolved (from checkNanoAvailability)
 * @returns {{ label: string|null, mode: string|null, outcome: string,
 *   error: string|null, lines: string[], lastPhase: string|null,
 *   probeLine: string|null }}
 */
export function buildAiDiagnostics(timer, { mode = null, outcome = "unknown", error = null, probeLine = null } = {}) {
  const lines = timer?.lines ? [...timer.lines] : [];
  const last = lines[lines.length - 1];
  return {
    label: timer?.label ?? null,
    mode,
    outcome,
    error: error != null ? String(error) : null,
    lines,
    lastPhase: last ? phaseOfLine(last) : null,
    probeLine: probeLine ?? null,
  };
}
