/**
 * Timeout / cancel tests for the Messy Token Checker data layer.
 *
 * Proves the 26 Nov 2026 live-test fix: no network hop in the app can hang
 * forever any more. Uses local HTTP servers (one that never answers, one
 * that answers at once) — no live API calls, so it runs anywhere.
 *
 * Run from the project dir:  node scripts/test-fetch-timeout.mjs
 *
 * Exit code 0 = all assertions passed, 1 = something failed.
 */
import http from "node:http";
import { fetchWithTimeout, withTimeout, TimeoutError } from "../src/data/http.js";
import { fetchTokenPairs } from "../src/data/dexscreener.js";
import { fetchTokenSecurity } from "../src/data/goplus.js";

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};

/** A server that accepts the connection and then never responds. */
const hanging = http.createServer(() => {});
await new Promise((resolve) => hanging.listen(0, "127.0.0.1", resolve));
const hangUrl = `http://127.0.0.1:${hanging.address().port}/slow`;

/** A server that answers 200 immediately. */
const fast = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end("{}");
});
await new Promise((resolve) => fast.listen(0, "127.0.0.1", resolve));
const fastUrl = `http://127.0.0.1:${fast.address().port}/ok`;

// ------------------------------------------- (1) hanging request times out
console.log("\n===== (1) fetchWithTimeout vs a server that never answers =====");
{
  const started = Date.now();
  let err = null;
  try {
    await fetchWithTimeout(hangUrl, { timeoutMs: 1500 });
  } catch (e) {
    err = e;
  }
  const elapsed = Date.now() - started;
  check("hanging request rejects", err !== null, err ? err.name : "resolved?!");
  check("rejection is a TimeoutError", err instanceof TimeoutError, err?.name);
  check(
    "timeout fires near the deadline (not immediately, not never)",
    elapsed >= 1400 && elapsed < 5000,
    `${elapsed}ms`,
  );
}

// ------------------------------------------------ (2) fast request succeeds
console.log("\n===== (2) fetchWithTimeout vs a fast server =====");
{
  const res = await fetchWithTimeout(fastUrl, { timeoutMs: 5000 });
  check("fast request returns 200", res.status === 200, `status=${res.status}`);
}

// ------------------------------------------- (3) pre-aborted signal fails fast
console.log("\n===== (3) fetchWithTimeout with an already-aborted signal =====");
{
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  let err = null;
  try {
    await fetchWithTimeout(fastUrl, { timeoutMs: 5000, signal: controller.signal });
  } catch (e) {
    err = e;
  }
  const elapsed = Date.now() - started;
  check("aborted request rejects", err !== null);
  check("aborted request rejects fast (<1s)", elapsed < 1000, `${elapsed}ms`);
  check("abort is NOT reported as a timeout", !(err instanceof TimeoutError), err?.name);
}

// ------------------------------------------------------- (4) withTimeout
console.log("\n===== (4) withTimeout =====");
{
  const fastValue = await withTimeout(Promise.resolve("ok"), 1000);
  check("fast promise passes its value through", fastValue === "ok");
  let err = null;
  const started = Date.now();
  try {
    await withTimeout(new Promise(() => {}), 500, "custom timeout msg");
  } catch (e) {
    err = e;
  }
  check("never-resolving promise rejects with TimeoutError", err instanceof TimeoutError);
  check("custom message is kept", err?.message === "custom timeout msg", err?.message);
  check("timeout fires near the deadline", Date.now() - started >= 450 && Date.now() - started < 2000, `${Date.now() - started}ms`);
}

// --------------------------------- (5) data modules honour an aborted signal
console.log("\n===== (5) data modules + aborted signal (Cancel plumbing) =====");
{
  const MESSY = "0x09f87f948c88848363b124c9099cbb58e4cc7cb6";
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  let err = null;
  try {
    await fetchTokenPairs(MESSY, { signal: controller.signal });
  } catch (e) {
    err = e;
  }
  check("fetchTokenPairs with aborted signal rejects", err !== null, err?.kind ?? "");
  check("fetchTokenPairs rejects fast (<2s, no live request made)", Date.now() - started < 2000, `${Date.now() - started}ms`);

  const gp = await fetchTokenSecurity(MESSY, { signal: controller.signal });
  check("fetchTokenSecurity with aborted signal degrades, never throws", gp?.available === false);
  check("fetchTokenSecurity reports the abort", /abort/i.test(gp?.error ?? ""), gp?.error);
}

hanging.close();
fast.close();

console.log(`\n================ RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ================`);
process.exit(failures === 0 ? 0 : 1);
