// scripts/test-ai-imports.mjs — Node smoke test for the AI layer.
//
// Verifies (no browser, no network, no Firebase console needed):
//  1. firebase/ai + firebase/app-check export everything the app uses.
//  2. src/ai/verdictSchema.js exports a Schema.object with the 6 expected
//     properties (and the SAFE/WATCH/RUG enum).
//  3. src/ai/prompts.js builds a short prompt containing the token + score.
//  4. src/ai/hybrid.js exports the hybrid helpers (model creation itself
//     needs a browser + user interaction, so it is NOT exercised here).
//
// A live generateContent call is NOT covered — it needs App Check console
// setup + a browser. See the manual live-test steps in the build report.
//
// Run from the project dir:  node scripts/test-ai-imports.mjs

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => path.join(here, "..", rel);

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS: ${name}`);
}

// 1. firebase/ai exports
const ai = await import("firebase/ai");
check("firebase/ai exports getAI", () =>
  assert.equal(typeof ai.getAI, "function"));
check("firebase/ai exports getGenerativeModel", () =>
  assert.equal(typeof ai.getGenerativeModel, "function"));
check("firebase/ai exports GoogleAIBackend", () =>
  assert.equal(typeof ai.GoogleAIBackend, "function"));
check("firebase/ai exports InferenceMode with PREFER_ON_DEVICE + ONLY_IN_CLOUD", () => {
  assert.equal(typeof ai.InferenceMode, "object");
  assert.ok(ai.InferenceMode.PREFER_ON_DEVICE, "missing PREFER_ON_DEVICE");
  assert.ok(ai.InferenceMode.ONLY_IN_CLOUD, "missing ONLY_IN_CLOUD");
});
check("firebase/ai exports Schema", () =>
  assert.equal(typeof ai.Schema, "function"));
check("firebase/ai exports InferenceSource (route detection)", () => {
  // SDK v13: InferenceSource = { ON_DEVICE: 'on_device', IN_CLOUD: 'in_cloud' }
  assert.equal(typeof ai.InferenceSource, "object");
  assert.ok("ON_DEVICE" in ai.InferenceSource);
  assert.ok("IN_CLOUD" in ai.InferenceSource);
});

// 2. firebase/app-check exports
const appCheck = await import("firebase/app-check");
check("firebase/app-check exports initializeAppCheck", () =>
  assert.equal(typeof appCheck.initializeAppCheck, "function"));
check("firebase/app-check exports ReCaptchaEnterpriseProvider", () =>
  assert.equal(typeof appCheck.ReCaptchaEnterpriseProvider, "function"));
check("firebase/app-check exports getToken (round-3 App Check prefetch)", () =>
  assert.equal(typeof appCheck.getToken, "function"));

// 3. verdictSchema — the 6 expected properties + enum
const { verdictSchema } = await import(src("src/ai/verdictSchema.js"));
const EXPECTED_PROPS = [
  "verdict",
  "score",
  "headline",
  "redFlags",
  "explanation",
  "nextSteps",
];
check("verdictSchema is a Schema.object", () => {
  assert.equal(verdictSchema.type, "object");
  assert.equal(typeof verdictSchema.properties, "object");
});
check("verdictSchema has the 6 expected properties", () => {
  const actual = Object.keys(verdictSchema.properties).sort();
  assert.deepEqual(actual, [...EXPECTED_PROPS].sort());
});
check("verdictSchema.verdict enum is SAFE/WATCH/RUG", () => {
  assert.deepEqual(verdictSchema.properties.verdict.enum, [
    "SAFE",
    "WATCH",
    "RUG",
  ]);
});
check("verdictSchema redFlags/nextSteps are string arrays", () => {
  assert.equal(verdictSchema.properties.redFlags.type, "array");
  assert.equal(verdictSchema.properties.redFlags.items.type, "string");
  assert.equal(verdictSchema.properties.nextSteps.type, "array");
  assert.equal(verdictSchema.properties.nextSteps.items.type, "string");
});

// 4. prompts.js — builds a short prompt with token + computed score
const { buildVerdictPrompt } = await import(src("src/ai/prompts.js"));
check("buildVerdictPrompt returns a short prompt with token + score", () => {
  const prompt = buildVerdictPrompt({
    token: {
      symbol: "MESSY",
      name: "Messy Virgo",
      address: "0x09f87f948c88848363b124c9099cbb58e4cc7cb6",
    },
    metrics: { protocol: 42, holder: 18, liquidity: 12 },
    score: { total: 72, verdict: "SAFE" },
  });
  assert.equal(typeof prompt, "string");
  assert.ok(prompt.includes("MESSY"), "prompt missing token symbol");
  assert.ok(prompt.includes("72"), "prompt missing total score");
  assert.ok(prompt.includes("SAFE"), "prompt missing verdict");
  assert.ok(prompt.length < 2000, `prompt too long for Nano: ${prompt.length}`);
});

// 5. hybrid.js — exports exist (model creation needs a browser; not run here)
const hybrid = await import(src("src/ai/hybrid.js"));
check("hybrid.js exports getHybridModel/getCloudOnlyModel/ensureDeviceModel/explainVerdict/checkNanoAvailability", () => {
  for (const name of [
    "getHybridModel",
    "getCloudOnlyModel",
    "ensureDeviceModel",
    "explainVerdict",
    "checkNanoAvailability",
  ]) {
    assert.equal(typeof hybrid[name], "function", `missing ${name}`);
  }
});
check("hybrid.js pins cloud model gemini-3.5-flash-lite (round 5)", () => {
  assert.equal(hybrid.CLOUD_MODEL, "gemini-3.5-flash-lite");
  assert.equal(hybrid.CLOUD_MODEL_DISPLAY, "Gemini 3.5 Flash-Lite");
});

// 6. firebase.js — imports cleanly in Node (App Check skipped, no window);
//    initFirebase() runs at import: initializeApp + getAI, no network.
const fb = await import(src("src/firebase.js"));
check("firebase.js exports app/ai/initFirebase", () => {
  assert.equal(typeof fb.initFirebase, "function");
  assert.ok(fb.app, "app is null after import");
  assert.ok(fb.ai, "ai is null after import");
});
check("firebase.js exports prefetchAppCheckToken (round-3 diagnosis)", () =>
  assert.equal(typeof fb.prefetchAppCheckToken, "function"));
check("firebase.js exports tokenExpiryNote (round-5 NaN guard)", () =>
  assert.equal(typeof fb.tokenExpiryNote, "function"));
check("tokenExpiryNote prints a real TTL, omits it when expiry is absent", () => {
  // Finite expiry ~3599s out → "(token expires in 3599s)".
  assert.equal(fb.tokenExpiryNote(Date.now() + 3599_000), "(token expires in 3599s)");
  // The public getToken() returns only { token } — no expireTimeMillis —
  // so undefined/NaN must yield "" and NEVER "NaNs" (26 Nov 2026 live bug).
  assert.equal(fb.tokenExpiryNote(undefined), "");
  assert.equal(fb.tokenExpiryNote(null), "");
  assert.equal(fb.tokenExpiryNote(NaN), "");
  assert.equal(fb.tokenExpiryNote("3599"), "");
});
// check() is sync, so the async assertion runs directly (top-level await):
assert.equal(await fb.prefetchAppCheckToken(), null);
passed += 1;
console.log("PASS: prefetchAppCheckToken returns null in Node (no App Check instance)");

// 7. timing.js — round-3 per-phase [ai-timing] log (console-only, shipped)
const { createAiTimer, buildAiDiagnostics, phaseOfLine } = await import(
  src("src/ai/timing.js")
);
check("timing.js exports createAiTimer", () =>
  assert.equal(typeof createAiTimer, "function"));
check("createAiTimer().mark logs without throwing in Node", () => {
  const timer = createAiTimer("test");
  assert.equal(typeof timer.mark, "function");
  assert.equal(typeof timer.mark("probe", "extra"), "number");
});

// 8. timing.js — round 4: the timer RECORDS its lines (the on-page AI
//    diagnostics block renders them; the cloud browser cannot open
//    DevTools, so console-only lines were unreadable in live re-tests).
check("timing.js exports buildAiDiagnostics + phaseOfLine", () => {
  assert.equal(typeof buildAiDiagnostics, "function");
  assert.equal(typeof phaseOfLine, "function");
});
check("createAiTimer records every marked line in order", () => {
  const timer = createAiTimer("check#7");
  timer.mark("runAi start", "mode=cloud-only");
  timer.mark("appcheck:getToken start");
  timer.mark("appcheck:getToken ok", "(token expires in 3599s)");
  assert.equal(timer.lines.length, 3);
  assert.ok(timer.lines[0].startsWith("[ai-timing check#7] runAi start +"));
  assert.ok(timer.lines[0].endsWith("mode=cloud-only"));
  assert.ok(timer.lines[2].includes("appcheck:getToken ok"));
  assert.ok(timer.lines[2].includes("(token expires in 3599s)"));
});
check("phaseOfLine extracts the stalled phase from a timing line", () => {
  assert.equal(
    phaseOfLine("[ai-timing check#7] generateContent start +1237ms"),
    "generateContent",
  );
  assert.equal(
    phaseOfLine("[ai-timing check#7] appcheck:getToken start +3ms"),
    "appcheck:getToken",
  );
  assert.equal(
    phaseOfLine("[ai-timing check#7] model:create cloud-only +1236ms"),
    "model:create",
  );
  assert.equal(phaseOfLine("not a timing line"), null);
  assert.equal(phaseOfLine(null), null);
});
check("buildAiDiagnostics snapshots lines + lastPhase + mode/outcome", () => {
  const timer = createAiTimer("retry");
  timer.mark("runAi start", "mode=cloud-only");
  timer.mark("appcheck:getToken start");
  const diag = buildAiDiagnostics(timer, {
    mode: "cloud-only",
    model: "gemini-3.5-flash-lite",
    outcome: "error",
    error: "The cloud AI request timed out after 90s.",
    probeLine: "[ai-timing probe] nano-probe status=unavailable +3ms",
  });
  assert.equal(diag.mode, "cloud-only");
  assert.equal(diag.model, "gemini-3.5-flash-lite");
  assert.equal(diag.outcome, "error");
  assert.equal(diag.error, "The cloud AI request timed out after 90s.");
  assert.equal(diag.lastPhase, "appcheck:getToken");
  assert.deepEqual(diag.lines, timer.lines);
  assert.notEqual(diag.lines, timer.lines, "lines must be a copy, not the live array");
  assert.equal(
    diag.probeLine,
    "[ai-timing probe] nano-probe status=unavailable +3ms",
  );
  // No attempt ran (null timer) → empty lines, no phase, no crash.
  const empty = buildAiDiagnostics(null, { outcome: "skipped" });
  assert.deepEqual(empty.lines, []);
  assert.equal(empty.lastPhase, null);
  assert.equal(empty.outcome, "skipped");
});

// 9. hybrid.js — checkNanoAvailability returns the probe ms (round 4:
//    main.js rebuilds the exact "[ai-timing probe]" line for the
//    on-page diagnostics block from it).
assert.equal(
  typeof (await hybrid.checkNanoAvailability()).ms,
  "number",
);
passed += 1;
console.log("PASS: checkNanoAvailability returns probe ms (round-4 diagnostics)");

console.log(`\nAll ${passed} checks passed.`);
