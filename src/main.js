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
 *      If both fail, the score/verdict/factors still render and the AI
 *      section shows an unavailable state + Retry.
 *   8. Render, save to recent checks.
 *
 * The app is fully usable without the AI call succeeding — the score is
 * computed locally and never depends on the model.
 */

import "./style.css";
import "./firebase.js"; // eager initFirebase() on import
import { fetchTokenPairs, isValidAddress, DexscreenerError } from "./data/dexscreener.js";
import { fetchTokenSecurity } from "./data/goplus.js";
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
  renderLoading(statusEl, addr);

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

  // Fire the device-model download WITHOUT awaiting it. Progress feeds
  // the bar; a failure just means the request falls back to cloud.
  if (model && !useCloudOnly) {
    showDownloadProgress();
    ensureDeviceModel(model, (progress) => {
      setDownloadProgress(progress);
      if (progress >= 1) hideDownloadProgress();
    }).catch((err) => {
      console.warn("[check] ensureDeviceModel failed (cloud fallback will run):", err);
      hideDownloadProgress();
    });
  }

  // 5. Fetch Dexscreener + GoPlus in parallel.
  let pairs;
  let goplus;
  try {
    [pairs, goplus] = await Promise.all([
      fetchTokenPairs(addr),
      fetchTokenSecurity(addr),
    ]);
  } catch (err) {
    checking = false;
    checkBtn.disabled = false;
    checkBtn.textContent = "Check token";
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
      score.metrics?.pairAgeDays != null
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
    try {
      ai = await runAi(prompt, useCloudOnly, model);
    } catch (err) {
      aiError = humanAiError(err);
      ai = null;
    }
  } else if (prompt && !model) {
    aiError =
      "The AI model could not be created in this browser (Firebase AI Logic is not initialized).";
  }

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

  checking = false;
  checkBtn.disabled = false;
  checkBtn.textContent = "Check token";
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
 * @param {string} prompt
 * @param {boolean} cloudOnly — true when the "Use cloud meanwhile" toggle is on
 * @param {object|null} existingModel — the model already created in this
 *   activation (runCheck creates it so ensureDeviceModel can run on it);
 *   when null a fresh model is created (Retry path)
 * @returns {Promise<{ data: object, route: string, routeCertain: boolean, rawText: string }>}
 * @throws the last error seen (cloud error if the retry ran, else hybrid error)
 */
async function runAi(prompt, cloudOnly, existingModel = null) {
  if (cloudOnly) {
    return explainVerdict(existingModel ?? getCloudOnlyModel(), prompt);
  }
  try {
    return await explainVerdict(existingModel ?? getHybridModel(), prompt);
  } catch (hybridErr) {
    console.warn("[check] hybrid model failed, retrying with cloud-only:", hybridErr);
    try {
      return await explainVerdict(getCloudOnlyModel(), prompt);
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
  return msg;
}

/** Re-run ONLY the AI call for the current result (Retry button). */
async function retryAi() {
  if (!currentResult || !lastPrompt) return;
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
    const ai = await runAi(lastPrompt, cloudToggle?.checked === true);
    currentResult = { ...currentResult, ai, aiError: null };
    renderResult(resultsEl, currentResult);
  } catch (err) {
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
