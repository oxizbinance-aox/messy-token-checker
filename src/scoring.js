/**
 * Deterministic scoring engine — Messy Token Checker.
 *
 * Implements RESEARCH.md §6d EXACTLY. The score is computed by this local,
 * rule-based engine from Dexscreener + GoPlus data; the AI is the explainer
 * only. Weights: Protocol 60 / Holder 25 / Liquidity 15 (of 100).
 * Verdict bands: SAFE >= 70, WATCH 45–69, RUG < 45.
 *
 * Honesty rules (also §6d):
 * - NEVER invent data. If a metric is missing, the factor scores only what
 *   is known and the gap is listed in `dataGaps`.
 * - If GoPlus is unavailable, Holder is scored from Dexscreener only where
 *   possible — Dexscreener has NO holder data, so Holder = 0 with a gap
 *   recorded (a measured 0 it is not; the reason says so). Protocol scores
 *   only the Dexscreener-known signals (pair age, website/socials) and
 *   records a gap for every GoPlus signal it could not check.
 * - `honeypot_with_same_creator == "1"` is a -5 yellow flag about the
 *   deployer, NEVER an auto-RUG (RESEARCH.md §6b note).
 * - Only `is_honeypot == "1"` auto-RUGs, clamping the total to 0–10.
 */

export const VERDICT_BANDS = [
  { verdict: "SAFE", min: 70, max: 100 },
  { verdict: "WATCH", min: 45, max: 69 },
  { verdict: "RUG", min: 0, max: 44 },
];

export const WEIGHTS = { protocol: 60, holder: 25, liquidity: 15 };

const BURN_ADDRESS = "0x000000000000000000000000000000000000dead";

/** Compact USD formatting: $27,692 / $1.24M / $3.10B / $0.50. Non-numbers → "n/a". */
export function formatUsd(n) {
  const v = Number(n);
  if (n == null || !Number.isFinite(v)) return "n/a";
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1000) return `${sign}$${Math.round(a).toLocaleString("en-US")}`;
  if (a >= 1) return `${sign}$${a.toFixed(2)}`;
  return `${sign}$${a.toFixed(4)}`;
}

function verdictFor(total) {
  if (total >= 70) return "SAFE";
  if (total >= 45) return "WATCH";
  return "RUG";
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/**
 * Score a token from already-fetched Dexscreener + GoPlus data.
 *
 * @param {{ pairs?: object|null, goplus?: object|null }} input
 *   `pairs` — the object returned by `fetchTokenPairs` (src/data/dexscreener.js)
 *   `goplus` — the object returned by `fetchTokenSecurity` (src/data/goplus.js)
 * @returns {{
 *   protocol: number, holder: number, liquidity: number, total: number,
 *   verdict: "SAFE"|"WATCH"|"RUG",
 *   reasons: {factor:"protocol"|"holder"|"liquidity", text:string, points:number}[],
 *   dataGaps: string[],
 *   metrics: object
 * }}
 *
 * `reasons[].points` is the signed delta that entry applies: protocol
 * entries are deductions from the 60-pt base (plus the +3 pair-age bonus);
 * holder/liquidity entries are the points AWARDED (base band points, then
 * negative penalty entries). So:
 *   protocol  = 60 + Σ protocol reason points, clamped to [0, 60]
 *   holder    = Σ holder reason points, clamped to [0, 25]
 *   liquidity = Σ liquidity reason points, clamped to [0, 15]
 */
export function scoreToken({ pairs = null, goplus = null } = {}) {
  const reasons = [];
  const dataGaps = [];
  const add = (factor, text, points) => reasons.push({ factor, text, points });

  const gp = goplus?.available === true ? goplus : null;
  const gpMissing = !gp;

  // ---------------------------------------------------------------- metrics
  const totalLiquidityUsd = pairs?.totalLiquidityUsd ?? null;
  const totalVolumeH24 = pairs?.totalVolumeH24 ?? null;
  const txns = pairs?.totalTxnsH24 ?? null;
  const buys = txns?.buys ?? 0;
  const sells = txns?.sells ?? 0;
  const totalTxns = buys + sells;
  const sellRatio = totalTxns > 0 ? sells / totalTxns : null;
  const pairAgeMs = pairs?.pairAgeMs ?? null;
  const pairAgeDays = pairAgeMs != null ? pairAgeMs / 86_400_000 : null;
  const websites = pairs?.websites ?? [];
  const socials = pairs?.socials ?? [];
  const buyTax = gp ? parseFloat(gp.buy_tax) : NaN;
  const sellTax = gp ? parseFloat(gp.sell_tax) : NaN;
  const maxTax =
    Number.isFinite(buyTax) || Number.isFinite(sellTax)
      ? Math.max(Number.isFinite(buyTax) ? buyTax : -Infinity, Number.isFinite(sellTax) ? sellTax : -Infinity)
      : null;
  const top10Percent = gp?.top10Percent ?? null;
  const holderCount = gp?.holder_count ?? null;
  const lpHolderCount = gp?.lp_holder_count ?? null;
  const isHoneypot = gp?.is_honeypot === "1";

  const metrics = {
    totalLiquidityUsd,
    totalVolumeH24,
    totalTxnsH24: txns ? { buys, sells } : null,
    sellRatio,
    pairAgeMs,
    pairAgeDays,
    priceUsd: pairs?.priceUsd ?? null,
    marketCap: pairs?.marketCap ?? null,
    fdv: pairs?.fdv ?? null,
    token: pairs?.token ?? null,
    websiteCount: websites.length,
    socialCount: socials.length,
    buyTax: Number.isFinite(buyTax) ? buyTax : null,
    sellTax: Number.isFinite(sellTax) ? sellTax : null,
    maxTax,
    holderCount,
    top10Percent,
    lpHolderCount,
    lpHolderCountKnown: lpHolderCount != null,
    isHoneypot,
    isOpenSource: gp?.is_open_source ?? null,
    isMintable: gp?.is_mintable ?? null,
    honeypotWithSameCreator: gp?.honeypot_with_same_creator ?? null,
    goplusAvailable: !gpMissing,
  };

  // ------------------------------------------------------------- PROTOCOL 60
  // Base 60; every entry below is a deduction (or the +3 age bonus).
  let protocolDelta = 0;
  const deduct = (text, pts) => {
    protocolDelta += pts;
    add("protocol", text, pts);
  };

  if (gpMissing) {
    dataGaps.push(
      "GoPlus security data unavailable — contract flags, taxes and holder data could not be checked; Protocol scores only what Dexscreener shows",
    );
    add("protocol", "GoPlus security data unavailable — contract safety could not be verified", 0);
  } else {
    // Contract verified — GoPlus is_open_source "0" means NOT open source.
    if (gp.is_open_source === "0") deduct("Contract source code is not verified (is_open_source = 0)", -15);
    else if (gp.is_open_source == null) {
      dataGaps.push("Contract verification status unknown (GoPlus returned no is_open_source value)");
    }
    // Mintable.
    if (gp.is_mintable === "1") deduct("Token is mintable — new supply can be created", -10);
    // Hidden owner / owner can change balances / can take back ownership: -8 each, cap -16.
    const ownerFlags = [
      ["hidden_owner", "Owner is hidden"],
      ["owner_change_balance", "Owner can change holder balances"],
      ["can_take_back_ownership", "Owner can take back ownership"],
    ].filter(([field]) => gp[field] === "1");
    const ownerDeduction = Math.min(ownerFlags.length * 8, 16);
    if (ownerDeduction > 0) {
      deduct(
        `Owner risk: ${ownerFlags.map(([, label]) => label).join("; ")} (−8 each, capped at −16)`,
        -ownerDeduction,
      );
    }
    // Self-destruct / proxy.
    if (gp.selfdestruct === "1") deduct("Contract can self-destruct", -8);
    if (gp.is_proxy === "1") deduct("Contract is a proxy — logic can be swapped", -4);
    // Blacklist / trading cooldown / pausable transfers: -5 each.
    if (gp.is_blacklisted === "1") deduct("Contract can blacklist wallets", -5);
    if (gp.trading_cooldown === "1") deduct("Trading cooldown is enabled", -5);
    if (gp.transfer_pausable === "1") deduct("Transfers can be paused", -5);
    // Buy/sell tax — one deduction on the HIGHER of buy/sell tax (§6d table
    // lists a single tax band, so the max tax is scored once, not per side).
    if (maxTax == null) {
      dataGaps.push("Buy/sell tax unknown (GoPlus returned no tax values)");
    } else if (maxTax <= 0) {
      // 0% tax → no deduction, no reason entry needed.
    } else if (maxTax <= 0.05) {
      deduct(`Buy/sell tax ${(maxTax * 100).toFixed(2)}% (≤5%)`, -2);
    } else if (maxTax <= 0.1) {
      deduct(`Buy/sell tax ${(maxTax * 100).toFixed(2)}% (5–10%)`, -6);
    } else if (maxTax <= 0.25) {
      deduct(`Buy/sell tax ${(maxTax * 100).toFixed(2)}% (10–25%)`, -12);
    } else {
      deduct(`Buy/sell tax ${(maxTax * 100).toFixed(2)}% (>25%)`, -20);
    }
    // Creator honeypot history: yellow flag ONLY — never an auto-RUG (§6b).
    if (gp.honeypot_with_same_creator === "1") {
      deduct(
        "Deployer previously deployed a honeypot (honeypot_with_same_creator) — yellow flag about the creator, not proof this token is one",
        -5,
      );
    }
  }

  // Pair age (Dexscreener pairCreatedAt via pairs.pairAgeMs).
  if (pairAgeDays == null) {
    dataGaps.push("Pair age unknown (Dexscreener returned no pairCreatedAt)");
  } else if (pairAgeDays < 1) {
    deduct(`Pair is very new (${pairAgeDays.toFixed(1)} days old, <24h)`, -8);
  } else if (pairAgeDays < 7) {
    deduct(`Pair is new (${pairAgeDays.toFixed(1)} days old, <7d)`, -4);
  } else if (pairAgeDays > 90) {
    protocolDelta += 3;
    add("protocol", `Pair is established (${Math.round(pairAgeDays)} days old, >90d)`, 3);
  }

  // Website / socials present.
  if (pairs == null) {
    dataGaps.push("Website/social links unknown (no Dexscreener pair data)");
  } else if (websites.length === 0 && socials.length === 0) {
    deduct("No website or social links listed on Dexscreener", -3);
  }

  const protocol = clamp(60 + protocolDelta, 0, 60);

  // --------------------------------------------------------------- HOLDER 25
  let holder = 0;
  if (gpMissing) {
    // Dexscreener provides NO holder data, so Holder cannot be scored from
    // it — 0 is the honest placeholder, explicitly flagged, not a measured 0.
    add(
      "holder",
      "Holder data unavailable (GoPlus unreachable; Dexscreener has no holder data) — holder sub-score set to 0, not a measured 0",
      0,
    );
    dataGaps.push("Holder data unavailable — GoPlus unreachable and Dexscreener provides no holder data");
  } else {
    let holderPts = 0;
    // Top-10 concentration bands (§6d): ≤20% → 25; 20–40% → 18; 40–60% → 10;
    // 60–80% → 5; >80% → 0.
    if (top10Percent == null) {
      add("holder", "Top-10 holder data missing — concentration could not be scored", 0);
      dataGaps.push("Top-10 holder concentration unknown (GoPlus returned no holder percents)");
    } else {
      const pct = top10Percent * 100;
      let pts;
      if (top10Percent <= 0.2) pts = 25;
      else if (top10Percent <= 0.4) pts = 18;
      else if (top10Percent <= 0.6) pts = 10;
      else if (top10Percent <= 0.8) pts = 5;
      else pts = 0;
      holderPts += pts;
      add("holder", `Top-10 holders own ${pct.toFixed(1)}% of supply → ${pts}/25 pts`, pts);
      dataGaps.push("Top-10 concentration is a proxy — full holder distribution unavailable");
    }
    // Holder count: <50 → −5; <10 → −10 (not cumulative; floor 0 overall).
    if (holderCount == null) {
      dataGaps.push("Holder count unknown (GoPlus returned no holder_count)");
    } else if (holderCount < 10) {
      holderPts -= 10;
      add("holder", `Only ${holderCount} holders (<10)`, -10);
    } else if (holderCount < 50) {
      holderPts -= 5;
      add("holder", `Only ${holderCount} holders (<50)`, -5);
    }
    // LP holders: 0 → −5.
    if (lpHolderCount == null) {
      dataGaps.push("LP holder data unavailable (GoPlus returned no lp_holder_count)");
    } else if (lpHolderCount === 0) {
      holderPts -= 5;
      add("holder", "No LP holders recorded", -5);
    }
    holder = clamp(holderPts, 0, 25);
  }

  // ------------------------------------------------------------ LIQUIDITY 15
  let liquidity = 0;
  if (totalLiquidityUsd == null) {
    add("liquidity", "Liquidity unknown (no Dexscreener pair data)", 0);
    dataGaps.push("Liquidity unknown (no Dexscreener pair data)");
  } else {
    let liqPts = 0;
    // Liquidity bands (§6d): ≥$100k → 15; $50–100k → 12; $10–50k → 8;
    // $1–10k → 4; <$1k → 0.
    let bandPts;
    if (totalLiquidityUsd >= 100_000) bandPts = 15;
    else if (totalLiquidityUsd >= 50_000) bandPts = 12;
    else if (totalLiquidityUsd >= 10_000) bandPts = 8;
    else if (totalLiquidityUsd >= 1_000) bandPts = 4;
    else bandPts = 0;
    liqPts += bandPts;
    add(
      "liquidity",
      `Total liquidity ${formatUsd(totalLiquidityUsd)} → ${bandPts}/15 pts`,
      bandPts,
    );
    // 24h volume $0 → −3 (dead pair).
    if (totalVolumeH24 == null) {
      dataGaps.push("24h volume unknown (Dexscreener returned no volume data)");
    } else if (totalVolumeH24 === 0) {
      liqPts -= 3;
      add("liquidity", "Zero 24h volume (dead pair)", -3);
    }
    // Sell-dominated: sells >90% of 24h txns → −3.
    if (sellRatio != null && sellRatio > 0.9) {
      liqPts -= 3;
      add(
        "liquidity",
        `Sell-dominated 24h flow: ${sells} sells vs ${buys} buys (${(sellRatio * 100).toFixed(0)}% sells)`,
        -3,
      );
    }
    liquidity = clamp(liqPts, 0, 15);
  }

  // LP lock status — §6d gap 2: no free source exposes a lock expiry.
  // Only exception: top LP holder is the burn address, which is verifiable.
  const topLpHolder = gp?.lp_holders?.[0]?.address?.toLowerCase?.() ?? null;
  if (topLpHolder === BURN_ADDRESS) {
    add("liquidity", "Top LP holder is the burn address (0x000…dead) — LP tokens verifiably burned", 0);
  } else {
    dataGaps.push("LP lock status not verifiable from free data");
  }
  // Ownership renounced — §6d gap 3: GoPlus has no direct field for it.
  dataGaps.push("Ownership renounced status cannot be verified from free data");

  // ------------------------------------------------------------------ total
  let total = protocol + holder + liquidity;
  total = clamp(total, 0, 100);

  // Honeypot auto-RUG (§6d): total clamped to 0–10 regardless of other factors.
  if (isHoneypot) {
    const before = total;
    total = Math.min(total, 10);
    add(
      "protocol",
      `HONEYPOT detected (is_honeypot = 1) — auto-RUG: total clamped from ${before} to ${total}`,
      0,
    );
  }

  const verdict = isHoneypot ? "RUG" : verdictFor(total);

  return {
    protocol,
    holder,
    liquidity,
    total,
    verdict,
    reasons,
    dataGaps,
    metrics,
  };
}
