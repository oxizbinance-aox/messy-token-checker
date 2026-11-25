// src/firebase.js — Firebase app + AI Logic (Gemini Developer API) + App Check.
//
// Init order matters: App Check is initialized BEFORE any AI Logic call,
// because App Check enforcement for Firebase AI Logic is automatic/mandatory.
// Call initFirebase() once at app startup (before the first token check).
// The module also runs initFirebase() eagerly on import in a browser so that
// `app` / `ai` are ready for src/ai/hybrid.js; in non-browser runtimes
// (e.g. Node smoke tests) App Check is skipped and init stays lazy-safe.

import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { getAI, GoogleAIBackend } from "firebase/ai";

// Public client config for the "messy-token-checker" Firebase project
// (Spark / no-cost plan). The apiKey in a Firebase web config is public by
// design — App Check is what protects it. Never put a debug token or any
// secret in this file.
const firebaseConfig = {
  apiKey: "AIzaSyBTlOwhLu73Z5LVxODTd5QtKCQBl7eIilo",
  authDomain: "messy-token-checker.firebaseapp.com",
  projectId: "messy-token-checker",
  storageBucket: "messy-token-checker.firebasestorage.app",
  messagingSenderId: "1091383452588",
  appId: "1:1091383452588:web:28c7fe863728254f979009",
};

// reCAPTCHA Enterprise site key (production App Check provider).
// Key "Messy Token Checker Web", Website score-based, domains
// messy-token-checker.web.app + messy-token-checker.firebaseapp.com only.
// Set 26 Nov 2026 (rotated API key the same day after GitHub secret alert).
const RECAPTCHA_ENTERPRISE_SITE_KEY = "6LdCSzEuAAAAAHIf7wDiZmij1LwwNAadEPCPim3L";

export let app = null;
export let ai = null;
export let appCheck = null;

let initialized = false;

/** True when running under Vite dev (`import.meta.env.DEV`) or on localhost. */
function isDevEnvironment() {
  // import.meta.env only exists under Vite; the ?. chain keeps this safe in Node.
  if (typeof import.meta !== "undefined" && import.meta.env?.DEV === true) return true;
  if (typeof window !== "undefined" && window.location) {
    const host = window.location.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  }
  return false;
}

/**
 * Initialize Firebase + App Check + AI Logic (idempotent).
 *
 * App Check:
 * - Dev/localhost ONLY: sets the App Check debug token flag BEFORE
 *   initializeAppCheck, so the DevTools console prints a debug token that
 *   must be registered in the Firebase console (Security > App Check >
 *   Manage debug tokens). This branch can NEVER run in a production build:
 *   it is gated on isDevEnvironment() (Vite DEV flag or localhost hostname).
 * - Production: reCAPTCHA Enterprise provider (see RECAPTCHA_ENTERPRISE_SITE_KEY).
 *
 * AI Logic uses the Gemini Developer API backend (free tier, no billing,
 * Spark plan). Do NOT switch to the Agent Platform (Vertex AI) backend —
 * it requires billing.
 *
 * @returns {{ app: import("firebase/app").FirebaseApp, ai: import("firebase/ai").AI, appCheck: import("firebase/app-check").AppCheck | null }}
 */
export function initFirebase() {
  if (initialized) return { app, ai, appCheck };

  app = initializeApp(firebaseConfig);

  if (typeof window !== "undefined") {
    if (isDevEnvironment()) {
      // Debug provider, dev-only. `globalThis` === `self` in browsers.
      // Setting this to `true` makes the SDK print a fresh debug token in
      // the DevTools console on first run; register it in the console.
      // NEVER commit a debug token value to the repo, and NEVER ship this
      // branch in production — the isDevEnvironment() gate prevents that.
      globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
      appCheck = initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY),
        isTokenAutoRefreshEnabled: true,
      });
    } else {
      appCheck = initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY),
        isTokenAutoRefreshEnabled: true,
      });
    }
  } else {
    // Non-browser runtime (Node smoke tests): no App Check provider exists.
    // AI calls are never made from here; initFirebase() stays safe to import.
    console.warn(
      "[firebase] No window object — App Check skipped (non-browser runtime). " +
        "AI calls require a browser.",
    );
  }

  // App Check is initialized above, before this first AI Logic call.
  ai = getAI(app, { backend: new GoogleAIBackend() });

  initialized = true;
  return { app, ai, appCheck };
}

// Eager init in browsers so `app` / `ai` are ready on import. In Node this
// still runs initializeApp + getAI (no network, no App Check) and is safe.
initFirebase();
