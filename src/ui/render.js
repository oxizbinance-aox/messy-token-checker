/**
 * Result rendering — Messy Token Checker.
 *
 * Layout order (per the build brief): input → score → verdict → factor
 * breakdown → red flags → AI deep dive → next steps. Everything is built
 * as DOM/HTML strings from the deterministic score + the AI explanation;
 * AI text is always escaped (it is model output, never trusted as HTML).
 *
 * Nothing here fetches or scores — main.js owns the check flow and hands
 * renderResult() a fully computed result object.
 */

import { formatUsd } from "../scoring.js";
import { esc, renderRouteBadge } from "./routeBadge.js";

const APP_URL = "https://app.messyvirgo.com";

/* ------------------------------------------------------------ small utils */

function verdictClass(verdict) {
  return verdict === "SAFE"
    ? "verdict-safe"
    : verdict === "RUG"
      ? "verdict-rug"
      : "verdict-watch";
}

function verdictColor(verdict) {
  return verdict === "SAFE"
    ? "#22c55e"
    : verdict === "RUG"
      ? "#ef4444"
      : "#f59e0b";
}

function verdictIcon(verdict) {
  return verdict === "SAFE" ? "✓" : verdict === "RUG" ? "✕" : "!";
}

function shortAddress(address) {
  if (!address) return "n/a";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function fmtPct(decimal) {
  if (decimal == null || !Number.isFinite(Number(decimal))) return "n/a";
  return `${(Number(decimal) * 100).toFixed(1)}%`;
}

function fmtAge(pairAgeMs) {
  if (pairAgeMs == null) return "n/a";
  const days = pairAgeMs / 86_400_000;
  if (days < 1) return `${(days * 24).toFixed(1)}h`;
  if (days < 365) return `${days.toFixed(0)}d`;
  return `${(days / 365).toFixed(1)}y`;
}

function factorBarClass(pct) {
  return pct >= 0.7 ? "safe" : pct >= 0.45 ? "watch" : "rug";
}

function pointsLabel(points) {
  if (points > 0) return `+${points}`;
  return `${points}`;
}

function pointsClass(points) {
  return points > 0 ? "pos" : points < 0 ? "neg" : "zero";
}

/* -------------------------------------------------------------- dial (SVG) */

function scoreDial(total, verdict) {
  const r = 66;
  const c = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(100, total)) / 100;
  const offset = c * (1 - filled);
  const color = verdictColor(verdict);
  return `
    <div class="dial-wrap">
      <div class="dial" role="img" aria-label="Safety score ${total} out of 100, verdict ${verdict}">
        <svg width="168" height="168" viewBox="0 0 168 168" aria-hidden="true">
          <circle class="dial-track" cx="84" cy="84" r="${r}" fill="none" stroke-width="12" />
          <circle class="dial-value" cx="84" cy="84" r="${r}" fill="none"
            stroke="${color}" stroke-width="12"
            stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}" />
        </svg>
        <div class="dial-center">
          <span class="dial-score">${total}</span>
          <span class="dial-outof">/ 100</span>
        </div>
      </div>
      <div class="dial-verdict-label ${verdictClass(verdict)}">${esc(verdict)}</div>
    </div>`;
}

/* ------------------------------------------------------------ factor rows */

function factorSection(label, weight, score, max, reasonsForFactor) {
  const pct = max > 0 ? score / max : 0;
  const items = (reasonsForFactor || [])
    .map(
      (r) => `<li><span class="pts ${pointsClass(r.points)}">${pointsLabel(r.points)}</span><span>${esc(r.text)}</span></li>`,
    )
    .join("");
  return `
    <div class="factor">
      <div class="factor-head">
        <span class="factor-name">${esc(label)} <span class="factor-weight">· ${weight} pts max</span></span>
        <span class="factor-score">${score} / ${max}</span>
      </div>
      <div class="factor-bar" role="img" aria-label="${esc(label)} ${score} of ${max}">
        <div class="factor-fill ${factorBarClass(pct)}" style="width: ${(pct * 100).toFixed(1)}%"></div>
      </div>
      ${items ? `<ul class="factor-reasons">${items}</ul>` : ""}
    </div>`;
}

/* ------------------------------------------------------------ state views */

/** Empty state — shown before the first check. */
export function renderEmptyState(container) {
  if (!container) return;
  container.innerHTML = `
    <div class="empty-state">
      <h2>No token checked yet</h2>
      <p>Paste a Base token contract address above — or tap
      <strong>Try $MESSY</strong> to see a real check. The score, the
      breakdown and the AI explanation will appear here.</p>
    </div>`;
}

/** Loading state — step list keeps the wait legible. `onCancel` (optional) wires the Cancel button.
 * The Cancel button sits in the header row (next to the title), not at
 * the bottom of the card — 26 Nov 2026 live test: at 1920×998 it was
 * below the fold and the tester had to scroll to find it. */
export function renderLoading(container, address, { onCancel } = {}) {
  if (!container) return;
  container.innerHTML = `
    <div class="state-box state-loading">
      <div class="spinner" aria-hidden="true"></div>
      <div class="loading-main">
        <div class="loading-head">
          <h2>Checking ${esc(shortAddress(address))}…</h2>
          <button type="button" class="btn-secondary" data-action="cancel-check">Cancel check</button>
        </div>
        <p>Fetching live market data, contract safety and holder data, then scoring locally.</p>
        <ul class="loading-steps">
          <li data-step="dexscreener">Dexscreener — pairs, liquidity, volume</li>
          <li data-step="goplus">GoPlus — contract flags, taxes, holders</li>
          <li data-step="score">Local score — Protocol 60 · Holder 25 · Liquidity 15</li>
          <li data-step="ai">AI explanation — on-device Nano first, cloud fallback</li>
        </ul>
        <p class="loading-note">Usually under a minute — the AI explanation can take a little longer on a slow connection. Each step has its own timeout, so a check never hangs forever; if it does run long, cancel and retry.</p>
      </div>
    </div>`;
  container
    .querySelector('[data-action="cancel-check"]')
    ?.addEventListener("click", () => {
      if (typeof onCancel === "function") onCancel();
    });
}

/**
 * Mark one loading step as "active" (in progress) or "done".
 * No-op when the loading state is gone (cancelled / finished / errored)
 * — the step list is replaced together with the rest of the state box.
 */
export function markLoadingStep(container, step, state) {
  if (!container) return;
  const li = container.querySelector(
    `.loading-steps li[data-step="${step}"]`,
  );
  if (!li) return;
  li.classList.remove("is-active", "is-done");
  if (state === "active") li.classList.add("is-active");
  else if (state === "done") li.classList.add("is-done");
}

/**
 * Error state. `kind` comes from DexscreenerError.kind (or 'unknown').
 * The not-found state always carries the quote-token note: USDC/WETH are
 * quote tokens, so Dexscreener's token-pairs endpoint returns no pairs
 * for them — that is a data blind spot, not a broken address.
 */
export function renderError(container, { kind, message, address }) {
  if (!container) return;
  const titles = {
    "invalid-address": "That doesn't look like a token address",
    "not-found": "No trading pairs found for this address",
    "rate-limit": "Dexscreener is rate-limiting us right now",
    timeout: "The data source took too long to respond",
    network: "Couldn't reach the data source",
    unknown: "Something went wrong",
  };
  const title = titles[kind] ?? titles.unknown;
  const nextSteps = {
    "invalid-address": `
      <p>A Base token contract address is <code>0x</code> followed by 40 hex
      characters (0–9, a–f). Copy it from the token's Dexscreener page or
      BaseScan — not a wallet address and not a pair address.</p>`,
    "not-found": `
      <p>Dexscreener has no trading pairs for
      <code>${esc(address ?? "")}</code> on Base. Either the address is
      wrong, the token has no liquidity yet, or it isn't a Base token.</p>
      <p class="quote-note"><strong>Heads up — the quote-token blind spot:</strong>
      USDC, WETH and other tokens that are (almost) always the
      <em>quote</em> side of a pair can't be checked this way:
      Dexscreener's token-pairs endpoint only returns pairs where the token
      is the <em>base</em> token, so it returns nothing for them. That is a
      limitation of the free data, not a problem with your address.</p>
      <p>Double-check the address on
      <a href="https://dexscreener.com/base/${esc(address ?? "")}" target="_blank" rel="noopener noreferrer">Dexscreener ↗</a>
      or
      <a href="https://basescan.org/address/${esc(address ?? "")}" target="_blank" rel="noopener noreferrer">BaseScan ↗</a>,
      then try again.</p>`,
    "rate-limit": `
      <p>Dexscreener allows 60 requests a minute and we're over it.
      Wait about a minute and tap Check again — your address is still in
      the box.</p>`,
    timeout: `
      <p>${esc(message ?? "Dexscreener didn't answer within 20 seconds.")}</p>
      <p>The data source is slow or unreachable right now — this is usually
      temporary. Tap Check again — your address is still in the box.</p>`,
    network: `
      <p>${esc(message ?? "The request failed before it reached the data source.")}</p>
      <p>Check your connection and try again.</p>`,
    unknown: `
      <p>${esc(message ?? "An unexpected error stopped the check.")}</p>
      <p>Try again — if it keeps failing, the address may not be a Base
      token contract.</p>`,
  };
  container.innerHTML = `
    <div class="state-box state-error" role="alert">
      <h2>${esc(title)}</h2>
      ${nextSteps[kind] ?? nextSteps.unknown}
      <button type="button" class="btn-secondary" data-action="focus-input">Back to the address box</button>
    </div>`;
  container
    .querySelector('[data-action="focus-input"]')
    ?.addEventListener("click", () => {
      document.getElementById("address-input")?.focus();
      document.getElementById("address-input")?.select();
    });
}

/* -------------------------------------------------------------- the result */

/**
 * Render a completed check.
 *
 * @param {HTMLElement} container — #results
 * @param {object} result
 * @param {object} result.pairs — fetchTokenPairs() output
 * @param {object} result.goplus — fetchTokenSecurity() output
 * @param {object} result.score — scoreToken() output, AFTER the
 *   GoPlus-down cap (verdict may be capped to WATCH; see main.js)
 * @param {boolean} result.capped — true when the verdict was capped
 *   from SAFE to WATCH because GoPlus was unavailable
 * @param {boolean} result.goplusDown — true when GoPlus was unavailable
 * @param {object|null} result.ai — { data, route, routeCertain } from
 *   explainVerdict(), or null when the AI call failed
 * @param {string|null} result.aiError — human-readable AI failure reason
 * @param {Function} result.onRetryAi — called by the Retry button
 */
export function renderResult(container, result) {
  if (!container) return;
  const { pairs, goplus, score, capped, goplusDown, ai, aiError } = result;
  const token = pairs?.token ?? {};
  const symbol = token.symbol ?? "Unknown token";
  const name = token.name ?? "";
  const address = token.address ?? "";
  const m = score.metrics ?? {};
  const verdict = score.verdict;
  const vClass = verdictClass(verdict);
  const reasonsByFactor = { protocol: [], holder: [], liquidity: [] };
  for (const r of score.reasons ?? []) {
    (reasonsByFactor[r.factor] ?? reasonsByFactor.protocol).push(r);
  }
  const redFlags = (score.reasons ?? []).filter((r) => r.points < 0);

  const verdictCopy = {
    SAFE: {
      icon: "✓",
      title: "Looks safe — by this check.",
      body: "No major red flags in the contract, holders or liquidity we could see. That is not a guarantee: a score is a snapshot of free public data, not an audit. Check the full due diligence before you buy.",
    },
    WATCH: {
      icon: "!",
      title: "Proceed with caution.",
      body: "Something in the contract, holders or liquidity needs a closer look before you buy. Read the red flags below, verify the top holders, and don't size a position you'd regret losing.",
    },
    RUG: {
      icon: "✕",
      title: "Do not buy — this looks like a rug.",
      body: "The score is driven by serious red flags. Walk away, or verify every single flag independently with a full audit before even thinking about it.",
    },
  }[verdict];

  const bestPair = pairs?.bestPair ?? {};
  const dexId = bestPair.dexId ?? "—";
  const pairAddress = bestPair.pairAddress ?? null;

  const aiCard = ai
    ? `
    <section class="card ai-card" aria-labelledby="ai-title">
      <div class="ai-head">
        <h2 id="ai-title">AI deep dive</h2>
        <span class="route-badge-slot" data-route-slot></span>
      </div>
      <p class="section-sub">Gemini explains the score in plain language. The score itself is computed locally — the AI never changes it.</p>
      <p class="ai-headline">“${esc(ai.data.headline ?? "")}”</p>
      <p class="ai-explanation">${esc(ai.data.explanation ?? "")}</p>
      ${
        Array.isArray(ai.data.redFlags) && ai.data.redFlags.length > 0
          ? `<h3 class="ai-subhead">AI red flags</h3>
             <ul class="ai-flags">${ai.data.redFlags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`
          : ""
      }
      ${
        Array.isArray(ai.data.nextSteps) && ai.data.nextSteps.length > 0
          ? `<h3 class="ai-subhead">What to verify next</h3>
             <ol class="ai-steps">${ai.data.nextSteps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`
          : ""
      }
    </section>`
    : `
    <section class="card ai-card ai-unavailable" aria-labelledby="ai-title">
      <div class="ai-head">
        <h2 id="ai-title">AI deep dive</h2>
        <span class="route-badge-slot" data-route-slot></span>
      </div>
      <p class="section-sub">Gemini explains the score in plain language.</p>
      <h3 style="font-size:16.5px;margin-bottom:6px;">AI explanation unavailable</h3>
      <p>${esc(aiError ?? "The AI call failed.")} The score above is computed
      locally and unaffected — it does not depend on the AI at all.</p>
      <button type="button" class="btn-secondary" data-action="retry-ai">Retry AI explanation</button>
    </section>`;

  container.innerHTML = `
  <div class="result">
    <section class="card result-card" aria-labelledby="token-title">
      <div class="result-top">
        ${scoreDial(score.total, verdict)}
        <div class="token-id">
          <h2 id="token-title">${esc(symbol)}</h2>
          ${name && name !== symbol ? `<p class="token-name">${esc(name)}</p>` : ""}
          <div class="token-address-row">
            <code class="token-address">${esc(address)}</code>
            <button type="button" class="copy-btn" data-action="copy-address" data-address="${esc(address)}">Copy address</button>
          </div>
          <div class="token-links">
            ${
              pairAddress
                ? `<a href="https://dexscreener.com/base/${esc(pairAddress)}" target="_blank" rel="noopener noreferrer">View pair on Dexscreener ↗</a>`
                : ""
            }
            <a href="https://basescan.org/token/${esc(address)}" target="_blank" rel="noopener noreferrer">BaseScan ↗</a>
            ${
              (pairs?.websites ?? [])
                .slice(0, 1)
                .map((w) => `<a href="${esc(w?.url ?? w)}" target="_blank" rel="noopener noreferrer">Website ↗</a>`)
                .join("")
            }
          </div>
        </div>
      </div>
      <div class="metric-strip">
        <div class="metric">
          <div class="metric-label">Price</div>
          <div class="metric-value">${m.priceUsd != null ? `$${Number(m.priceUsd).toFixed(6)}` : "n/a"}</div>
          <div class="metric-sub">${esc(dexId)} · ${esc(fmtAge(m.pairAgeMs))} old</div>
        </div>
        <div class="metric">
          <div class="metric-label">Market cap</div>
          <div class="metric-value">${formatUsd(m.marketCap)}</div>
          <div class="metric-sub">FDV ${formatUsd(m.fdv)}</div>
        </div>
        <div class="metric">
          <div class="metric-label">Liquidity</div>
          <div class="metric-value">${formatUsd(m.totalLiquidityUsd)}</div>
          <div class="metric-sub">${(pairs?.pairs?.length ?? 0)} pair(s) on Dexscreener</div>
        </div>
        <div class="metric">
          <div class="metric-label">24h volume</div>
          <div class="metric-value">${formatUsd(m.totalVolumeH24)}</div>
          <div class="metric-sub">${m.totalTxnsH24 ? `${m.totalTxnsH24.buys} buys / ${m.totalTxnsH24.sells} sells` : "n/a"}</div>
        </div>
      </div>
    </section>

    <div class="verdict-banner ${vClass}" role="status">
      <span class="banner-icon" aria-hidden="true">${verdictCopy.icon}</span>
      <div>
        <h3>${esc(verdict)} — ${esc(verdictCopy.title)}</h3>
        <p>${esc(verdictCopy.body)}</p>
      </div>
    </div>

    ${
      goplusDown
        ? `<div class="verdict-banner is-warning" role="alert">
          <span class="banner-icon" aria-hidden="true">⚠</span>
          <div>
            <h3>Security data unavailable — ${capped ? "verdict capped at WATCH" : "score is incomplete"}</h3>
            <p>GoPlus (contract flags, taxes, holder data) could not be reached for this check
            ${goplus?.error ? `(${esc(goplus.error)})` : ""}. ${
              capped
                ? "This token scored SAFE on market data alone, but without contract verification we will not call it safe — the verdict is capped at WATCH until the contract can be verified."
                : "Holder and contract signals are missing from the score above; treat the result as a partial check."
            }</p>
          </div>
        </div>`
        : ""
    }

    <section class="card factors" aria-labelledby="factors-title">
      <h2 id="factors-title">How the score breaks down</h2>
      <p class="section-sub">Protocol ${score.protocol} · Holder ${score.holder} · Liquidity ${score.liquidity} — total ${score.total} / 100, every point accounted for below.</p>
      ${factorSection("Protocol", 60, score.protocol, 60, reasonsByFactor.protocol)}
      ${factorSection("Holder", 25, score.holder, 25, reasonsByFactor.holder)}
      ${factorSection("Liquidity", 15, score.liquidity, 15, reasonsByFactor.liquidity)}
    </section>

    <section class="card redflags" aria-labelledby="redflags-title">
      <h2 id="redflags-title">Red flags</h2>
      <p class="section-sub">Every scoring deduction, in one place.</p>
      ${
        redFlags.length > 0
          ? `<ul class="redflags-list">${redFlags.map((r) => `<li>${esc(r.text)} <span class="pts neg">(${pointsLabel(r.points)})</span></li>`).join("")}</ul>`
          : `<p class="redflags-none">✓ No deductions — nothing in the contract, holders or liquidity scored against this token.</p>`
      }
    </section>

    ${aiCard}

    ${
      Array.isArray(score.dataGaps) && score.dataGaps.length > 0
        ? `<section class="card gaps" aria-labelledby="gaps-title">
          <h2 id="gaps-title">What we couldn't verify</h2>
          <p class="section-sub">Honest gaps — free data has limits, and we don't pretend otherwise.</p>
          <ul class="gaps-list">${score.dataGaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>
        </section>`
        : ""
    }

    <section class="card next-steps" aria-labelledby="next-title">
      <h2 id="next-title" class="sr-only">Next steps</h2>
      <p><strong>Next steps:</strong> ${
        verdict === "RUG"
          ? "Walk away. If you still want to look, verify every red flag above against the contract on BaseScan and check the deployer — never buy on hope."
          : verdict === "WATCH"
            ? "Verify the top holders and the contract flags above, check the project's website and socials, and only then decide — with money you can afford to lose."
            : "Still do your own research: read the contract, check the team and the tokenomics, and never put in more than you can afford to lose."
      }</p>
      <div class="cta-row">
        <a class="cta-link" href="${APP_URL}" target="_blank" rel="noopener noreferrer">Full Messy check on app.messyvirgo.com ↗</a>
        <button type="button" class="btn-secondary" data-action="check-another">Check another token</button>
      </div>
    </section>
  </div>`;

  // Wire the in-result buttons.
  container
    .querySelector('[data-action="copy-address"]')
    ?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const addr = btn.getAttribute("data-address") ?? "";
      try {
        await navigator.clipboard.writeText(addr);
        btn.textContent = "Copied ✓";
      } catch {
        // Clipboard API unavailable (non-secure context) — select instead.
        btn.textContent = addr;
      }
      setTimeout(() => {
        btn.textContent = "Copy address";
      }, 2000);
    });
  container
    .querySelector('[data-action="check-another"]')
    ?.addEventListener("click", () => {
      const input = document.getElementById("address-input");
      input?.focus();
      input?.select();
      document
        .querySelector(".checker")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  container
    .querySelector('[data-action="retry-ai"]')
    ?.addEventListener("click", () => {
      if (typeof result.onRetryAi === "function") result.onRetryAi();
    });

  // Route badge goes in the AI card's slot (only when we have a route).
  const slot = container.querySelector("[data-route-slot]");
  if (slot && ai) renderRouteBadge(slot, ai.route, ai.routeCertain);
}

/* --------------------------------------------------------- recent checks */

const RECENT_KEY = "messy-token-checker:recent";
const RECENT_MAX = 8;

/** Load recent checks from localStorage (never throws). */
export function loadRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Save a check to recent history (last 8, newest first). */
export function saveRecent(entry) {
  try {
    const list = loadRecent().filter(
      (e) => e.address?.toLowerCase() !== entry.address?.toLowerCase(),
    );
    list.unshift(entry);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    // Storage full / unavailable — history is a nicety, not a blocker.
  }
}

export function clearRecent() {
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Render the recent-checks list. `onSelect(address)` is called when a
 * history item is clicked (main.js re-runs the check).
 */
export function renderRecent(container, section, onSelect) {
  if (!container || !section) return;
  const list = loadRecent();
  if (list.length === 0) {
    section.hidden = true;
    container.innerHTML = "";
    return;
  }
  section.hidden = false;
  container.innerHTML = list
    .map(
      (e) => `
      <li>
        <button type="button" class="recent-item" data-address="${esc(e.address ?? "")}">
          <span class="recent-verdict ${verdictClass(e.verdict)}">${esc(e.verdict ?? "?")}</span>
          <span class="recent-symbol">${esc(e.symbol ?? "Unknown")}</span>
          <span class="recent-score">${e.total ?? "?"} / 100</span>
          <span class="recent-addr">${esc(e.address ?? "")}</span>
        </button>
      </li>`,
    )
    .join("");
  container.querySelectorAll(".recent-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const addr = btn.getAttribute("data-address");
      if (addr && typeof onSelect === "function") onSelect(addr);
    });
  });
}
