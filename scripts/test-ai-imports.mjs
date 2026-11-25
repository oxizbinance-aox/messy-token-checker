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
check("hybrid.js pins cloud model gemini-3.8-flash", () =>
  assert.equal(hybrid.CLOUD_MODEL, "gemini-3.8-flash"));

// 6. firebase.js — imports cleanly in Node (App Check skipped, no window);
//    initFirebase() runs at import: initializeApp + getAI, no network.
const fb = await import(src("src/firebase.js"));
check("firebase.js exports app/ai/initFirebase", () => {
  assert.equal(typeof fb.initFirebase, "function");
  assert.ok(fb.app, "app is null after import");
  assert.ok(fb.ai, "ai is null after import");
});

console.log(`\nAll ${passed} checks passed.`);
