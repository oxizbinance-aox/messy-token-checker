/**
 * Messy Token Checker — main UI wiring + check flow.
 *
 * Check flow (every step runs inside the "Check token" click handler,
 * which is the user activation Firebase AI Logic requires):
 *   1. Validate the address → invalid-address error state.
 *   2. Loading state.
 *   3. checkNanoAvailability() → Nano status chip (never blocks).
 *   4. Create the hybrid model; fire ensureDeviceModel WITHOUT awaiting
 *      (progress bar via callback; the request falls back to cloud if
 *      Nano isn't ready yet). The "Use cloud meanwhile" toggle instead
 *      uses getCloudOnlyModel() and skips the device download entirely.
 *   5. Fetch Dexscreener + GoPlus in parallel.
 *   6. Score locally; apply the GoPlus-down cap (SAFE → WATCH when the
 *      contract could not be verified).
 *   7. buildVerdictPrompt (with the CAPPED verdict) + explainVerdict in
 *      try/catch: the hybrid model runs first and, on ANY failure, the
 *      call is retried once with the cloud-only model (PREFER_ON_DEVICE
 *      does not fall back when the on-device model itself rejects the
 *      request — live-tested 26 Nov 2026: "The input is too large").
 *      EXCEPTION: when the Nano probe already said "unavailable", the
 *      hybrid attempt is skipped entirely and the AI goes straight to
 *      cloud-only — otherwise the check waits ~180s (two 90s timeouts)
 *      for an AI that cannot run on-device (26 Nov 2026: $MESSY took
 *      3–4 min and the AI timed out).
 *      If both fail, the score/verdict/factors still render and the AI
 *      section shows an unavailable state + Retry.
 *   8. Render, save to recent checks.
 *
 * The app is fully usable without the AI call succeeding — the score is
 * computed locally and never depends on the model.
 */

import "./style.css";
import "./firebase.js"; // eager initFirebase() on import
import { prefetchAppCheckToken } from "./firebase.js";
import { createAiTimer } from "./ai/timing.js";
import { fetchTokenPairs, isValidAddress, DexscreenerError } from "./data/dexscreener.js";
import { fetchTokenSecurity } from "./data/goplus.js";
import { withTimeout } from "./data/http.js";
import { scoreToken } from "./scoring.js";
import { buildVerdictPrompt } from "./ai/prompts.js";
import {
  getHybridModel,
  getCloudOnlyModel,
  ensureDeviceModel,
  explainVerdict,
  checkNanoAvailability,
} from "./ai/hybrid.js";
import {
  renderRouteBadge,
  renderNanoChip,
  showDownloadProgress,
  setDownloadProgress,
  hideDownloadProgress,
} from "./ui/routeBadge.js";
import {
  renderEmptyState,
  renderLoading,
  markLoadingStep,
  renderError,
  renderResult,
  loadRecent,
  saveRecent,
  clearRecent,
  renderRecent,
} from "./ui/render.js";

const form = document.getElementById("check-form");
const input = document.getElementById("address-input");
const checkBtn = document.getElementById("check-btn");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const nanoChipEl = document.getElementById("nano-chip");
const cloudToggle = document.getElementById("cloud-toggle");
const recentSection = document.getElementById("recent-section");
const recentList = document.getElementById("recent-list");
const clearRecentBtn = document.getElementById("clear-recent");

/** Last completed check, kept so the AI Retry button can re-run only the AI call. */
let currentResult = null;
/** The prompt of the last check (for Retry — the score never changes on retry). */
let lastPrompt = null;

let checking = false;

/**
 * Timeouts that bound the whole check (26 Nov 2026 live test: a BRETT
 * check hung at "Checking…" for 3.5+ minutes with no timeout, no error
 * and no way out — every stage was unbounded).
 * - Each data source gives up after 20s (see src/data/dexscreener.js,
 *   src/data/goplus.js).
 * - Each AI attempt gives up after 90s (hybrid, then cloud retry).
 * - The whole check gives up after 4 minutes, whatever stage it is in.
 * - The Nano availability probe gets 5s before we decide about the
 *   download bar (it is a local API call and normally resolves in ms).
 */
const AI_TIMEOUT_MS = 90_000;
const NANO_STATUS_TIMEOUT_MS = 5_000;
const OVERALL_CHECK_TIMEOUT_MS = 240_000;
/**
 * App Check token prefetch bound (round 3): the token fetch is the one
 * phase of generateContent the app could not see — reCAPTCHA Enterprise
 * execute + token exchange. It normally takes 1–5s; 30s is 6–30x that.
 * If it cannot complete in 30s, the generateContent call that follows
 * would burn its full 90s on the same stall, so runAi fails fast with a
 * precise App Check error instead (the Retry button can re-run it).
 */
const APPCHECK_TIMEOUT_MS = 30_000;

/** Sequence number of the current check — stale continuations bail out. */
let checkSeq = 0;
/** AbortController of the current check's data fetches (Cancel button). */
let currentAbort = null;
/** Overall-check watchdog timer (cleared on every exit path). */
let overallTimer = null;
/**
 * Whether the last Nano availability probe said "unavailable".
 * When true, runAi skips the hybrid model entirely and goes straight to
 * cloud-only (see runAi) — trying PREFER_ON_DEVICE first in a browser
 * with no Nano wastes up to 90s before the cloud retry runs (live-tested
 * 26 Nov 2026: the $MESSY check took 3–4 min and the AI timed out).
 * Updated by each check; retryAi reuses the last value.
 */
let lastNanoUnavailable = false;

/** Reset the check button / checking flag and clear the watchdog. */
function finishCheck() {
  if (overallTimer) {
    clearTimeout(overallTimer);
    overallTimer = null;
  }
  checking = false;
  checkBtn.disabled = false;
  checkBtn.textContent = "Check token";
}

/**
 * Cancel the running check (Cancel button, or the overall watchdog).
 * Aborts the data fetches and invalidates every in-flight continuation
 * via checkSeq, so no late result can render over the reset UI.
 * `reason` "timeout" shows the timeout error state; anything else shows
 * the empty state.
 */
function cancelCheck(reason) {
  currentAbort?.abort();
  checkSeq++;
  hideDownloadProgress();
  finishCheck();
  resultsEl.innerHTML = "";
  if (reason === "timeout") {
    renderError(statusEl, {
      kind: "timeout",
      message: "The check took longer than 4 minutes overall — something stalled. Try again.",
    });
  } else {
    renderEmptyState(statusEl);
  }
}

/* ------------------------------------------------------- Nano status chip */

/** Refresh the Nano chip. Never throws, never blocks the check. */
async function refreshNanoChip() {
  try {
    const nano = await checkNanoAvailability();
    renderNanoChip(nanoChipEl, nano);
    return nano;
  } catch {
    renderNanoChip(nanoChipEl, {
      status: "unavailable",
      detail: "checkNanoAvailability() failed.",
    });
    return { status: "unavailable", detail: "" };
  }
}

/* ------------------------------------------------------------ the check */

async function runCheck(address) {
  if (checking) return;
  const addr = (address ?? "").trim();

  // 1. Validate.
  if (!isValidAddress(addr)) {
    input.classList.add("input-error");
    resultsEl.innerHTML = "";
    renderError(statusEl, {
      kind: "invalid-address",
      address: addr,
    });
    return;
  }
  input.classList.remove("input-error");

  checking = true;
  checkBtn.disabled = true;
  checkBtn.textContent = "Checking…";
  resultsEl.innerHTML = "";
  renderLoading(statusEl, addr, { onCancel: () => cancelCheck("user") });
  markLoadingStep(statusEl, "dexscreener", "active");
  markLoadingStep(statusEl, "goplus", "active");
  // Bring the progress card (and its Cancel button) into view immediately:
  // the status sits below the form, so without this the Cancel button can
  // sit below the fold while the check runs (26 Nov 2026 live test).
  // "instant", not "smooth" — the button must be visible the moment the
  // check starts, not after a scroll animation.
  statusEl.scrollIntoView({ behavior: "instant", block: "start" });

  // This check's identity: the Cancel button / watchdog invalidate it by
  // bumping checkSeq, and every continuation below bails out on mismatch.
  const mySeq = ++checkSeq;
  const abort = new AbortController();
  currentAbort = abort;
  overallTimer = setTimeout(() => {
    if (mySeq === checkSeq) cancelCheck("timeout");
  }, OVERALL_CHECK_TIMEOUT_MS);

  // 3. Nano status — fire and forget, never blocks the check.
  const nanoPromise = refreshNanoChip();

  // 4. Create the model INSIDE the click handler (user activation).
  //    The cloud toggle is read at click time.
  let model;
  let useCloudOnly = false;
  try {
    useCloudOnly = cloudToggle?.checked === true;
    model = useCloudOnly ? getCloudOnlyModel() : getHybridModel();
  } catch (err) {
    // Model creation failed (e.g. Firebase not initialized) — the score
    // path does not need the model, so keep going; the AI step will
    // report unavailable.
    console.warn("[check] model creation failed:", err);
    model = null;
  }

  // Fire the device-model download WITHOUT awaiting it — but ONLY when
  // Nano can actually run in this browser. Live test 26 Nov 2026: the
  // bar sat at 0% for the whole session in a browser where Nano is
  // unavailable, because initializeDeviceModel never resolved, rejected
  // or called back. "available" still needs the init call before
  // generateContent, but shows no bar (nothing to download);
  // "downloading"/"downloadable" show the bar; "unavailable" skips the
  // download entirely and the check falls back to cloud.
  if (model && !useCloudOnly) {
    const nano = await Promise.race([
      nanoPromise,
      new Promise((resolve) =>
        setTimeout(() => resolve({ status: "unavailable" }), NANO_STATUS_TIMEOUT_MS),
      ),
    ]);
    // Remember the probe outcome for the AI step: when Nano is
    // unavailable, runAi skips the hybrid model and goes straight to
    // cloud-only instead of burning up to 90s on a doomed hybrid attempt.
    lastNanoUnavailable = nano?.status === "unavailable";
    if (
      nano?.status === "available" ||
      nano?.status === "downloading" ||
      nano?.status === "downloadable"
    ) {
      if (nano.status !== "available") showDownloadProgress();
      ensureDeviceModel(model, (progress) => {
        setDownloadProgress(progress);
        if (progress >= 1) hideDownloadProgress();
      })
        .then(() => hideDownloadProgress())
        .catch((err) => {
          console.warn("[check] ensureDeviceModel failed (cloud fallback will run):", err);
          hideDownloadProgress();
        });
    }
  }

  // 5. Fetch Dexscreener + GoPlus in parallel. Each source has its own
  //    20s timeout; the Cancel button aborts both via the signal.
  //    Dexscreener failing/timing out is a hard error (no market data =
  //    no score); GoPlus failing/timing out degrades gracefully — the
  //    score is computed from Dexscreener data and SAFE is capped at
  //    WATCH (fetchTokenSecurity never throws).
  let pairs;
  let goplus;
  try {
    [pairs, goplus] = await Promise.all([
      fetchTokenPairs(addr, { signal: abort.signal }),
      fetchTokenSecurity(addr, { signal: abort.signal }),
    ]);
  } catch (err) {
    if (mySeq !== checkSeq) return; // cancelled — UI already reset
    finishCheck();
    hideDownloadProgress();
    const kind =
      err instanceof DexscreenerError
        ? err.kind
        : err?.kind ?? "unknown";
    renderError(statusEl, {
      kind,
      message: err?.message ?? String(err),
      address: addr,
    });
    return;
  }
  if (mySeq !== checkSeq) return; // cancelled while fetching

  // Both data sources are in — tick them off, scoring is next.
  markLoadingStep(statusEl, "dexscreener", "done");
  markLoadingStep(statusEl, "goplus", "done");
  markLoadingStep(statusEl, "score", "active");

  // 6. Score locally; apply the GoPlus-down cap.
  let score = scoreToken({ pairs, goplus });
  const goplusDown = goplus?.available !== true;
  let capped = false;
  if (goplusDown && score.verdict === "SAFE") {
    capped = true;
    score = {
      ...score,
      verdict: "WATCH",
      reasons: [
        ...score.reasons,
        {
          factor: "holder",
          text: "Security data unavailable — verdict capped at WATCH until the contract can be verified.",
          points: 0,
        },
      ],
    };
  }

  // 7. AI explanation — the prompt gets the CAPPED verdict. Any failure
  //    leaves the score UI intact; the AI card shows unavailable + Retry.
  //
  // Prompt size matters: Gemini Nano's context window is small, so the
  // metrics are compact — numbers plus SHORT reason labels (the full
  // reason text is already shown in the factor breakdown on the page).
  // A long reason like "Deployer previously deployed a honeypot … — yellow
  // flag about the creator, not proof this token is one" is sent as
  // "Deployer previously deployed a honeypot (honeypot_with_same_creator)".
  const shortReason = (r) => {
    let t = String(r?.text ?? "");
    const dash = t.indexOf(" — ");
    if (dash > 0) t = t.slice(0, dash);
    t = t.replace(/\s*→\s*\d+\/\d+ pts$/, "");
    if (t.length > 80) t = `${t.slice(0, 77)}…`;
    return `${r?.factor ?? "?"}: ${t} (${r?.points ?? 0})`;
  };
  const metrics = {
    protocol: score.protocol,
    holder: score.holder,
    liquidity: score.liquidity,
    top10ConcentrationPct:
      score.metrics?.top10Percent != null
        ? +score.metrics.top10Percent.toFixed(3)
        : null,
    holderCount: score.metrics?.holderCount ?? null,
    liquidityUsd: score.metrics?.totalLiquidityUsd ?? null,
    volumeH24Usd: score.metrics?.totalVolumeH24 ?? null,
    txnsH24: score.metrics?.totalTxnsH24 ?? null,
    buyTaxPct:
      score.metrics?.buyTax != null
        ? +(score.metrics.buyTax * 100).toFixed(2)
        : null,
    sellTaxPct:
      score.metrics?.sellTax != null
        ? +(score.metrics.sellTax * 100).toFixed(2)
        : null,
    pairAgeDays:
      score.metrics?.pairAgeDaysDisplay != null
        ? score.metrics.pairAgeDaysDisplay
        : score.metrics?.pairAgeDays != null
          ? +score.metrics.pairAgeDays.toFixed(1)
          : null,
    honeypot: score.metrics?.isHoneypot ?? false,
    goplusAvailable: score.metrics?.goplusAvailable ?? false,
    cappedAtWatch: capped,
    reasons: (score.reasons ?? []).map(shortReason),
  };
  let prompt = null;
  let ai = null;
  let aiError = null;
  try {
    prompt = buildVerdictPrompt({
      token: pairs.token,
      metrics,
      score: { total: score.total, verdict: score.verdict },
    });
    lastPrompt = prompt;
  } catch (err) {
    aiError = `Could not build the AI prompt: ${err?.message ?? err}`;
    lastPrompt = null;
  }

  if (prompt && model) {
    markLoadingStep(statusEl, "score", "done");
    markLoadingStep(statusEl, "ai", "active");
    try {
      ai = await runAi(prompt, useCloudOnly, model, lastNanoUnavailable, `check#${mySeq}`);
    } catch (err) {
      aiError = humanAiError(err);
      ai = null;
    }
    markLoadingStep(statusEl, "ai", "done");
  } else if (prompt && !model) {
    markLoadingStep(statusEl, "score", "done");
    markLoadingStep(statusEl, "ai", "done");
    aiError =
      "The AI model could not be created in this browser (Firebase AI Logic is not initialized).";
  } else {
    // No prompt (prompt build failed) — the AI stage is over either way.
    markLoadingStep(statusEl, "score", "done");
    markLoadingStep(statusEl, "ai", "done");
  }
  if (mySeq !== checkSeq) return; // cancelled while the AI was running

  // 8. Render + remember.
  statusEl.innerHTML = "";
  currentResult = {
    pairs,
    goplus,
    score,
    capped,
    goplusDown,
    ai,
    aiError,
    onRetryAi: () => retryAi(),
  };
  renderResult(resultsEl, currentResult);
  saveRecent({
    address: pairs.token?.address ?? addr,
    symbol: pairs.token?.symbol ?? "Unknown",
    total: score.total,
    verdict: score.verdict,
    ts: Date.now(),
  });
  renderRecent(recentList, recentSection, (a) => {
    input.value = a;
    runCheck(a);
  });

  // The Nano chip promise may still be resolving — it updates the chip
  // whenever it lands; nothing here depends on it.
  void nanoPromise;

  finishCheck();
  resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * Run one AI explanation with the hybrid-then-cloud fallback.
 *
 * PREFER_ON_DEVICE falls back to cloud automatically in most cases, but
 * live-tested 26 Nov 2026 it does NOT fall back when the on-device model
 * itself rejects the request (e.g. "The input is too large") — it throws.
 * So: try the hybrid model first; on ANY failure, retry once with the
 * cloud-only model. Both attempts happen inside the same user activation.
 *
 * EXCEPTION — Nano unavailable (26 Nov 2026, $MESSY check took 3–4 min
 * and the AI timed out): when LanguageModel.availability() already said
 * "unavailable", the hybrid attempt still burns up to its 90s timeout
 * before the cloud retry runs, so the check waits ~180s for the AI alone.
 * When `nanoUnavailable` is true we skip the hybrid attempt entirely and
 * go straight to the cloud-only model — one 90s-bounded call instead of
 * two. (The $MESSY prompt is ~1019 chars vs BRETT ~1013 — prompt size
 * does not explain the slowness; the hybrid attempt in a Nano-less
 * browser does.)
 *
 * @param {string} prompt
 * @param {boolean} cloudOnly — true when the "Use cloud meanwhile" toggle is on
 * @param {object|null} existingModel — the model already created in this
 *   activation (runCheck creates it so ensureDeviceModel can run on it);
 *   when null a fresh model is created (Retry path)
 * @param {boolean} [nanoUnavailable] — true when the Nano probe said
 *   "unavailable": skip the hybrid attempt, go straight to cloud-only
 * @param {string} [checkId] — per-check label for the [ai-timing] log
 *   (e.g. "check#7"); "retry" on the Retry path
 * @returns {Promise<{ data: object, route: string, routeCertain: boolean, rawText: string }>}
 * @throws the last error seen (cloud error if the retry ran, else hybrid error)
 */
async function runAi(prompt, cloudOnly, existingModel = null, nanoUnavailable = false, checkId = "check") {
  const timer = createAiTimer(checkId);
  timer.mark(
    "runAi start",
    `mode=${cloudOnly || nanoUnavailable ? "cloud-only" : "hybrid"}`,
  );

  // App Check token prefetch (round 3) — the prime suspect for the 90s
  // stall: generateContent fetches this token internally and invisibly
  // (reCAPTCHA Enterprise execute + exchange with
  // firebaseappcheck.googleapis.com). If that hop hangs, the whole call
  // burns its 90s with no clue which phase stalled. Prefetch it
  // explicitly with its own 30s bound: the SDK caches the token, so the
  // generateContent call that follows reuses it instead of fetching it
  // again. If the prefetch itself cannot complete in 30s, fail fast
  // with a precise App Check error — the generateContent call would hit
  // the exact same stall and burn its full 90s.
  // NOTE: a 429/quota error would surface here (or in generateContent)
  // as an error, not a hang — throttling does not explain a 90s stall.
  try {
    await withTimeout(
      prefetchAppCheckToken(timer),
      APPCHECK_TIMEOUT_MS,
      "App Check token fetch timed out after 30s.",
    );
  } catch (err) {
    timer.mark("appcheck:getToken FAILED");
    throw new Error(
      `[hybrid] App Check token fetch failed: ${err?.message ?? err}`,
    );
  }

  // Each attempt is bounded (live test 26 Nov 2026: the check hung for
  // 3.5+ min — a stalled generateContent would do the same). The Cancel
  // button / overall watchdog still cover the whole check.
  if (cloudOnly || nanoUnavailable) {
    // No Nano in this browser (or the toggle forced cloud): never spend
    // a 90s hybrid attempt on a model that cannot run — cloud directly.
    // A fresh cloud-only model is created here (existingModel may be the
    // hybrid one); creation is cheap and still inside user activation.
    const model = getCloudOnlyModel();
    timer.mark("model:create cloud-only");
    const out = await withTimeout(
      explainVerdict(model, prompt, timer),
      AI_TIMEOUT_MS,
      "The cloud AI request timed out after 90s.",
    );
    timer.mark("runAi done", `route=${out.route}`);
    return out;
  }
  try {
    const model = existingModel ?? getHybridModel();
    timer.mark("model:create hybrid");
    const out = await withTimeout(
      explainVerdict(model, prompt, timer),
      AI_TIMEOUT_MS,
      "The AI request timed out after 90s.",
    );
    timer.mark("runAi done", `route=${out.route}`);
    return out;
  } catch (hybridErr) {
    console.warn("[check] hybrid model failed, retrying with cloud-only:", hybridErr);
    timer.mark("hybrid failed, retrying cloud-only");
    try {
      const model = getCloudOnlyModel();
      timer.mark("model:create cloud-only (retry)");
      const out = await withTimeout(
        explainVerdict(model, prompt, timer),
        AI_TIMEOUT_MS,
        "The cloud AI request timed out after 90s.",
      );
      timer.mark("runAi done", `route=${out.route}`);
      return out;
    } catch (cloudErr) {
      // The cloud error is usually the actionable one (App Check, network,
      // quota); keep it, but remember the hybrid failure in the message
      // when the cloud error is generic.
      const cloudMsg = String(cloudErr?.message ?? cloudErr);
      const hybridMsg = String(hybridErr?.message ?? hybridErr);
      if (/too large/i.test(hybridMsg) && !/App Check|fetch|network|quota|429/i.test(cloudMsg)) {
        throw new Error(
          `On-device model rejected the prompt as too large, and the cloud fallback also failed: ${cloudMsg}`,
        );
      }
      throw cloudErr;
    }
  }
}

/**
 * Turn a raw AI error into a clean human-readable reason for the UI.
 * The AI card already renders the "AI explanation unavailable" heading
 * and the "score above is computed locally" sentence, so this returns
 * ONLY the reason — no duplicated prefix, no "[hybrid]" internals.
 */
function humanAiError(err) {
  const raw = err?.message ?? String(err);
  const msg = raw.replace(/^\[hybrid\]\s*/i, "").trim();
  if (/App Check token fetch/i.test(msg)) {
    // Round 3: the explicit token prefetch (reCAPTCHA execute + token
    // exchange) could not complete in 30s. This is NOT "App Check is not
    // configured" — App Check IS configured and the token fetch worked
    // before (26 Nov 2026 04:52 + 05:11) — it is the fetch itself
    // stalling. Say so, so the live timings can confirm which hop it is.
    return "Could not get an App Check token in 30s — the reCAPTCHA check or Google's token service did not answer in time. Retry in a moment.";
  }
  if (/App Check|app-check|appcheck|appCheck\/fetch/i.test(msg)) {
    return "App Check is not configured for this app yet — the Firebase console steps (reCAPTCHA Enterprise key + App Check registration) are still pending, so the cloud route can't run.";
  }
  if (/too large/i.test(msg)) {
    return "The on-device model rejected the prompt as too large, and the cloud fallback also failed. Try the 'Use cloud meanwhile' toggle, or retry in a moment.";
  }
  if (/not valid JSON|invalid verdict/i.test(msg)) {
    return "The model returned a response that could not be parsed as a verdict.";
  }
  if (/Failed to fetch|fetch failed|network|ERR_TUNNEL|Failed to connect/i.test(msg)) {
    return "The cloud request could not reach Google (no network from this browser, or the request was blocked).";
  }
  if (/429|quota|RESOURCE_EXHAUSTED/i.test(msg)) {
    return "The cloud request hit a rate limit or quota — wait a minute and retry.";
  }
  if (/timed out|timeout/i.test(msg)) {
    // NOTE: do NOT repeat "the score above is unaffected" here — the AI
    // card already appends that sentence once (26 Nov 2026 live test:
    // it rendered twice).
    return "The AI request timed out — the model was too slow to answer. Retry in a moment.";
  }
  return msg;
}

/** Re-run ONLY the AI call for the current result (Retry button). */
async function retryAi() {
  if (!currentResult || !lastPrompt) return;
  const target = currentResult; // a new check starting meanwhile wins
  const aiCard = resultsEl.querySelector(".ai-card");
  if (aiCard) {
    aiCard.classList.add("ai-unavailable");
    const retryBtn = aiCard.querySelector('[data-action="retry-ai"]');
    if (retryBtn) {
      retryBtn.disabled = true;
      retryBtn.textContent = "Retrying…";
    }
  }
  try {
    // Model creation again on this user interaction (Retry click).
    // Reuse the last Nano probe outcome: in a Nano-less browser the
    // retry also goes straight to cloud-only instead of burning a
    // 90s hybrid attempt first.
    const ai = await runAi(lastPrompt, cloudToggle?.checked === true, null, lastNanoUnavailable, "retry");
    if (currentResult !== target) return; // a new check replaced the result
    currentResult = { ...currentResult, ai, aiError: null };
    renderResult(resultsEl, currentResult);
  } catch (err) {
    if (currentResult !== target) return;
    currentResult = {
      ...currentResult,
      ai: null,
      aiError: humanAiError(err),
    };
    renderResult(resultsEl, currentResult);
  }
}

/* ---------------------------------------------------------------- wiring */

form.addEventListener("submit", (e) => {
  e.preventDefault();
  runCheck(input.value);
});

input.addEventListener("input", () => {
  input.classList.remove("input-error");
});

document.querySelectorAll(".sample-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const addr = btn.getAttribute("data-address");
    if (!addr) return;
    input.value = addr;
    runCheck(addr);
  });
});

clearRecentBtn?.addEventListener("click", () => {
  clearRecent();
  renderRecent(recentList, recentSection, (a) => {
    input.value = a;
    runCheck(a);
  });
});

/* ----------------------------------------------------------------- boot */

renderEmptyState(statusEl);
renderRecent(recentList, recentSection, (a) => {
  input.value = a;
  runCheck(a);
});
refreshNanoChip();

// Keep the route-badge module import used (badge renders inside render.js).
void renderRouteBadge;
void loadRecent;
