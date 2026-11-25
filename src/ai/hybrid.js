// src/ai/hybrid.js — Hybrid inference: on-device Gemini Nano first,
// cloud Gemini (same SDK) as automatic fallback.
//
// Route model (Firebase AI Logic, JS SDK v12.5.0+):
//   InferenceMode.PREFER_ON_DEVICE — Nano if available, else cloud.
//   InferenceMode.ONLY_IN_CLOUD   — cloud only (the "use cloud meanwhile"
//                                    path while Nano is still downloading,
//                                    and the dev toggle).
//
// IMPORTANT — user activation: getGenerativeModel() MUST be called after/on
// an end-user interaction (e.g. inside the "Check token" click handler).
// That is a prerequisite for the hybrid `mode` to work. Likewise,
// ensureDeviceModel() must run on user activation and BEFORE generateContent.
// So: never create the model at module load — the caller (main.js) creates
// it inside the click handler and passes it to explainVerdict().

import { getGenerativeModel, InferenceMode } from "firebase/ai";
import { ai } from "../firebase.js";
import { verdictSchema } from "./verdictSchema.js";

// Cloud model pinned per parent verification (26 Nov 2026) against the
// official Firebase AI Logic models page:
// https://firebase.google.com/docs/ai-logic/models
// `gemini-3.8-flash` is a STABLE model. Do NOT use the SDK v13 default
// fallback (gemini-3.5-flash-lite) — we override it here on purpose.
export const CLOUD_MODEL = "gemini-3.8-flash";

// Canonical route labels returned by explainVerdict(). The SDK's
// InferenceSource enum values are lowercase ('on_device' / 'in_cloud');
// we normalize to these uppercase labels so the UI has one stable contract.
export const ROUTE_ON_DEVICE = "ON_DEVICE";
export const ROUTE_IN_CLOUD = "IN_CLOUD";
export const ROUTE_LIKELY_ON_DEVICE = "likely on-device";
export const ROUTE_LIKELY_CLOUD = "likely cloud";

/**
 * Create the hybrid model (Nano first, cloud fallback).
 * MUST be called on/after a user interaction (see header comment).
 */
export function getHybridModel() {
  if (!ai) {
    throw new Error(
      "[hybrid] Firebase AI is not initialized. Call initFirebase() first.",
    );
  }
  return getGenerativeModel(ai, {
    mode: InferenceMode.PREFER_ON_DEVICE,
    inCloudParams: {
      model: CLOUD_MODEL,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: verdictSchema,
      },
    },
    onDeviceParams: {
      promptOptions: {
        responseConstraint: verdictSchema,
      },
    },
  });
}

/**
 * Create a cloud-only model — the "use cloud meanwhile" path while Nano is
 * still downloading, and the dev toggle for forcing the cloud route.
 * MUST be called on/after a user interaction (same rule as getHybridModel).
 */
export function getCloudOnlyModel() {
  if (!ai) {
    throw new Error(
      "[hybrid] Firebase AI is not initialized. Call initFirebase() first.",
    );
  }
  return getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_IN_CLOUD,
    inCloudParams: {
      model: CLOUD_MODEL,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: verdictSchema,
      },
    },
    onDeviceParams: {
      promptOptions: {
        responseConstraint: verdictSchema,
      },
    },
  });
}

/**
 * Download / initialize the on-device model, forwarding progress (0..1)
 * to onProgress for the UI progress bar.
 * MUST run on user activation and BEFORE generateContent.
 *
 * Safety bound (26 Nov 2026 live test: the download bar sat at 0% for the
 * whole session while the SDK neither resolved nor rejected): the init is
 * raced against a 120s timeout so it can never hang forever — the caller
 * hides the bar and the check falls back to cloud.
 *
 * @param {import("firebase/ai").GenerativeModel} model
 * @param {(progress: number) => void} [onProgress]
 */
export async function ensureDeviceModel(model, onProgress) {
  if (!model || typeof model.initializeDeviceModel !== "function") {
    throw new Error(
      "[hybrid] ensureDeviceModel: expected a GenerativeModel with initializeDeviceModel().",
    );
  }
  const init = (async () => {
    try {
      await model.initializeDeviceModel((progress) => {
        const p =
          typeof progress === "number" && Number.isFinite(progress)
            ? Math.min(1, Math.max(0, progress))
            : 0;
        if (typeof onProgress === "function") onProgress(p);
      });
    } catch (err) {
      throw new Error(
        `[hybrid] On-device model download/initialization failed: ${err?.message || err}`,
      );
    }
  })();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            "[hybrid] On-device model download timed out after 120s — cloud fallback will run.",
          ),
        ),
      120_000,
    );
  });
  try {
    await Promise.race([init, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Strip ```json / ``` fences the model may wrap around its JSON with. */
function stripCodeFences(text) {
  const trimmed = String(text).trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

/** Normalize a raw inferenceSource value to a canonical route label. */
function normalizeRoute(raw) {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "on_device" || v === "on-device" || v === "ondevice") {
    return ROUTE_ON_DEVICE;
  }
  if (v === "in_cloud" || v === "in-cloud" || v === "incloud") {
    return ROUTE_IN_CLOUD;
  }
  return null;
}

/**
 * Run one verdict explanation and report which route actually ran.
 *
 * @param {import("firebase/ai").GenerativeModel} model — from getHybridModel()/getCloudOnlyModel()
 * @param {string} prompt — from buildVerdictPrompt()
 * @param {{ mark: (name: string, extra?: string) => number } | null} [timer]
 *   — per-check [ai-timing] timer (round 3); logs generateContent timing
 * @returns {Promise<{ data: object, route: string, routeCertain: boolean, rawText: string }>}
 *   data: parsed verdict JSON. route: "ON_DEVICE" | "IN_CLOUD" (certain),
 *   or "likely on-device" | "likely cloud" (inferred fallback).
 *   routeCertain is false when the route had to be inferred.
 */
export async function explainVerdict(model, prompt, timer = null) {
  if (!model || typeof model.generateContent !== "function") {
    throw new Error(
      "[hybrid] explainVerdict: expected a GenerativeModel from getHybridModel() or getCloudOnlyModel().",
    );
  }
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new Error("[hybrid] explainVerdict: prompt must be a non-empty string.");
  }

  let result;
  timer?.mark("generateContent start");
  try {
    result = await model.generateContent(prompt);
    timer?.mark("generateContent ok");
  } catch (err) {
    timer?.mark("generateContent error");
    throw new Error(
      `[hybrid] generateContent failed: ${err?.message || err}`,
    );
  }

  let rawText;
  try {
    rawText = result.response.text();
  } catch (err) {
    throw new Error(
      `[hybrid] Could not read the model response text: ${err?.message || err}`,
    );
  }

  let data;
  try {
    data = JSON.parse(stripCodeFences(rawText));
  } catch (err) {
    throw new Error(
      `[hybrid] Model response was not valid JSON: ${err?.message || err}. Raw text: ${rawText.slice(0, 200)}`,
    );
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("[hybrid] Model response JSON was not an object.");
  }
  if (!["SAFE", "WATCH", "RUG"].includes(data.verdict)) {
    throw new Error(
      `[hybrid] Model response has an invalid verdict: ${JSON.stringify(data.verdict)}. Expected SAFE, WATCH or RUG.`,
    );
  }

  // Route detection (JS SDK v12.5.0+): result.response.inferenceSource.
  // Fallback if the property is ever missing: infer from
  // LanguageModel.availability() and label the route as "likely ...".
  // The availability probe is bounded (5s race): it is a local API, but
  // an unguarded await here would stall explainVerdict after a
  // successful generateContent — and the round-3 audit found this was
  // the one await in the AI path with no timeout of its own.
  let route = normalizeRoute(result.response?.inferenceSource);
  let routeCertain = route !== null;
  if (!routeCertain) {
    const availability = await Promise.race([
      (async () => {
        try {
          return typeof LanguageModel !== "undefined"
            ? await LanguageModel.availability()
            : "unavailable";
        } catch {
          return "unavailable";
        }
      })(),
      new Promise((resolve) => setTimeout(() => resolve("unavailable"), 5_000)),
    ]);
    route =
      availability === "available"
        ? ROUTE_LIKELY_ON_DEVICE
        : ROUTE_LIKELY_CLOUD;
  }

  return { data, route, routeCertain, rawText };
}

/**
 * Check whether on-device (Gemini Nano / Prompt API) is usable in this
 * browser. Never throws — returns a status object the UI can render.
 *
 * @returns {Promise<{ status: "available" | "downloading" | "downloadable" | "unavailable", detail: string }>}
 */
export async function checkNanoAvailability() {
  // Round-3 timing: the probe is phase (a) of the AI path. Log it in the
  // same [ai-timing] format so the live re-test can see whether the probe
  // itself ever stalls (it is a local API and normally resolves in ms).
  // Round 4: the elapsed ms is also returned, so main.js can rebuild the
  // exact probe line for the on-page AI diagnostics block (the cloud
  // browser cannot open DevTools, so console lines alone are unreadable).
  const hasPerf =
    typeof performance !== "undefined" &&
    typeof performance.now === "function";
  const t0 = hasPerf ? performance.now() : Date.now();
  const ms = () =>
    Math.round((hasPerf ? performance.now() : Date.now()) - t0);
  const log = (status) => {
    const probeMs = ms();
    console.log(`[ai-timing probe] nano-probe status=${status} +${probeMs}ms`);
    return probeMs;
  };
  if (typeof LanguageModel === "undefined") {
    const probeMs = log("unavailable");
    return {
      status: "unavailable",
      detail:
        "LanguageModel (Prompt API) is not present in this browser. On-device inference needs Chrome on Desktop v139+ with the Prompt API flag enabled.",
      ms: probeMs,
    };
  }
  try {
    const status = await LanguageModel.availability();
    if (
      status === "available" ||
      status === "downloading" ||
      status === "downloadable"
    ) {
      const probeMs = log(status);
      return { status, detail: `LanguageModel.availability() returned "${status}".`, ms: probeMs };
    }
    const probeMs = log("unavailable");
    return {
      status: "unavailable",
      detail: `LanguageModel.availability() returned "${status}".`,
      ms: probeMs,
    };
  } catch (err) {
    const probeMs = log("unavailable");
    return {
      status: "unavailable",
      detail: `LanguageModel.availability() threw: ${err?.message || err}`,
      ms: probeMs,
    };
  }
}
