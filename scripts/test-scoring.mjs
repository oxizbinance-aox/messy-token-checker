/**
 * Live test for the Messy Token Checker data layer + scoring engine.
 *
 * Run from the project dir:  node scripts/test-scoring.mjs
 *
 * Cases:
 *  (a) $MESSY 0x09f87f948c88848363b124c9099cbb58e4cc7cb6 — live fetch + score.
 *      Hand-check: ~4.9% tax, verified contract, 735 holders.
 *      NOTE 26 Nov live: top-10 is 61.8% (RESEARCH.md §6b quoted ~27%, but
 *      that was only the TOP 3; holders 4–10 add ~35%). Expect WATCH ~66.
 *      Must NOT auto-RUG on honeypot_with_same_creator.
 *  (b) BRETT on Base 0x532f27101965dd16442E59d40670FaF5eBB142E4 — live fetch + score.
 *      Expect a high SAFE-path score (verified, non-mintable, 0% tax,
 *      top-10 ~33%, $1.4M liquidity, balanced 24h flow).
 *      USDC was the original (b) token, but Dexscreener's token endpoints
 *      return ZERO pairs for it (it is a quote token, never a base token —
 *      verified live via /token-pairs, /tokens/v1 AND /search). Case (b2)
 *      below asserts that blind spot instead of pretending USDC works.
 *  (c) Invalid address — expect a clean `invalid-address` error from Dexscreener.
 *  (d) MOCKED GoPlus honeypot payload (is_honeypot "1", no live fetch) —
 *      proves the auto-RUG clamp (total 0–10, verdict RUG) works.
 *
 * Exit code 0 = all assertions passed, 1 = something failed.
 */
import { fetchTokenPairs, isValidAddress } from "../src/data/dexscreener.js";
import { fetchTokenSecurity } from "../src/data/goplus.js";
import { scoreToken, VERDICT_BANDS, formatUsd } from "../src/scoring.js";

const MESSY = "0x09f87f948c88848363b124c9099cbb58e4cc7cb6";
const BRETT = "0x532f27101965dd16442E59d40670FaF5eBB142E4";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bd029029"; // quote-token blind spot, see (b2)

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};

function printScore(label, result) {
  console.log(`\n--- ${label} ---`);
  console.log(`  Protocol : ${result.protocol}/60`);
  console.log(`  Holder   : ${result.holder}/25`);
  console.log(`  Liquidity: ${result.liquidity}/15`);
  console.log(`  TOTAL    : ${result.total}/100  →  ${result.verdict}`);
  console.log(`  Verdict bands: ${VERDICT_BANDS.map((b) => `${b.verdict} ${b.min}–${b.max}`).join(", ")}`);
  console.log("  Reasons:");
  for (const r of result.reasons) {
    const sign = r.points > 0 ? `+${r.points}` : `${r.points}`;
    console.log(`    [${r.factor}] (${sign}) ${r.text}`);
  }
  console.log("  Data gaps:");
  for (const g of result.dataGaps) console.log(`    - ${g}`);
  console.log("  Metrics:", JSON.stringify(result.metrics, null, 2));
}

async function liveCase(label, address) {
  console.log(`\n===== (live) ${label} — ${address} =====`);
  console.log(`  isValidAddress: ${isValidAddress(address)}`);
  const pairs = await fetchTokenPairs(address);
  console.log(
    `  Dexscreener: ${pairs.pairs.length} pair(s), best=${pairs.bestPair.dexId} ` +
      `price=${pairs.priceUsd} marketCap=${formatUsd(pairs.marketCap)} ` +
      `totalLiquidity=${formatUsd(pairs.totalLiquidityUsd)} ` +
      `vol24h=${formatUsd(pairs.totalVolumeH24)} ` +
      `txns24h=${pairs.totalTxnsH24.buys} buys / ${pairs.totalTxnsH24.sells} sells ` +
      `pairAge=${pairs.pairAgeMs != null ? (pairs.pairAgeMs / 86400000).toFixed(1) + "d" : "?"}`,
  );
  const goplus = await fetchTokenSecurity(address);
  if (goplus.available) {
    console.log(
      `  GoPlus: honeypot=${goplus.is_honeypot} open_source=${goplus.is_open_source} ` +
        `mintable=${goplus.is_mintable} buy_tax=${goplus.buy_tax} sell_tax=${goplus.sell_tax} ` +
        `holders=${goplus.holder_count} top10=${((goplus.top10Percent ?? 0) * 100).toFixed(1)}% ` +
        `lp_holders=${goplus.lp_holder_count} same_creator_honeypot=${goplus.honeypot_with_same_creator}`,
    );
  } else {
    console.log(`  GoPlus UNAVAILABLE: ${goplus.error}`);
  }
  const result = scoreToken({ pairs, goplus });
  printScore(label, result);
  return { pairs, goplus, result };
}

// ---------------------------------------------------------------- (a) $MESSY
const messy = await liveCase("$MESSY", MESSY);
check("MESSY: GoPlus data available", messy.goplus.available === true, messy.goplus.error ?? "");
check("MESSY: not a honeypot (is_honeypot = 0)", messy.goplus.is_honeypot === "0");
check("MESSY: contract verified (is_open_source = 1)", messy.goplus.is_open_source === "1");
check(
  "MESSY: buy tax ≈ 4.9%",
  Math.abs(parseFloat(messy.goplus.buy_tax) - 0.049) < 0.005,
  `buy_tax=${messy.goplus.buy_tax}`,
);
check(
  "MESSY: holder count in a sane range (500–1000)",
  messy.goplus.holder_count >= 500 && messy.goplus.holder_count <= 1000,
  `holders=${messy.goplus.holder_count}`,
);
check(
  "MESSY: top-10 is 60–80% band live (61.8%; RESEARCH.md's ~27% was top-3 only)",
  (messy.goplus.top10Percent ?? 0) > 0.6 && (messy.goplus.top10Percent ?? 0) < 0.8,
  `top10=${((messy.goplus.top10Percent ?? 0) * 100).toFixed(1)}%`,
);
check("MESSY: holder sub-score is 5 (60–80% band)", messy.result.holder === 5, `holder=${messy.result.holder}`);
check("MESSY: total 66 → WATCH (sane: clean contract, concentrated top-10, sell-heavy day)", messy.result.total === 66 && messy.result.verdict === "WATCH", `total=${messy.result.total}`);
check(
  "MESSY: NOT auto-RUGged on honeypot_with_same_creator",
  messy.result.verdict !== "RUG" || messy.result.total > 10 || messy.goplus.is_honeypot === "1",
  `verdict=${messy.result.verdict} total=${messy.result.total} same_creator=${messy.goplus.honeypot_with_same_creator}`,
);
check(
  "MESSY: creator-history flag scored as a -5 deduction only",
  messy.result.reasons.some((r) => r.points === -5 && r.text.includes("honeypot_with_same_creator")),
);
check("MESSY: total is in 0–100", messy.result.total >= 0 && messy.result.total <= 100);
check(
  "MESSY: sub-scores add up to total (no honeypot clamp here)",
  messy.result.protocol + messy.result.holder + messy.result.liquidity === messy.result.total,
);

// ----------------------------------------------------------------- (b) BRETT
const brett = await liveCase("BRETT on Base", BRETT);
check("BRETT: GoPlus data available", brett.goplus.available === true, brett.goplus.error ?? "");
check("BRETT: not a honeypot", brett.goplus.is_honeypot === "0");
check("BRETT: not mintable, verified, 0% tax", brett.goplus.is_mintable === "0" && brett.goplus.is_open_source === "1" && brett.goplus.buy_tax === "0");
check(
  "BRETT: high liquidity (≥ $100k → 15 pts)",
  (brett.pairs.totalLiquidityUsd ?? 0) >= 100_000,
  `liquidity=${formatUsd(brett.pairs.totalLiquidityUsd)}`,
);
check("BRETT: liquidity sub-score is 15", brett.result.liquidity === 15, `liq=${brett.result.liquidity}`);
check("BRETT: holder sub-score is 18 (top-10 20–40%)", brett.result.holder === 18, `holder=${brett.result.holder}`);
check("BRETT: SAFE with a high total (≥ 85)", brett.result.verdict === "SAFE" && brett.result.total >= 85, `total=${brett.result.total} verdict=${brett.result.verdict}`);

// ------------------------------------------------- (b2) USDC quote-token blind spot
console.log("\n===== (b2) USDC on Base — Dexscreener quote-token blind spot =====");
console.log("  USDC is (almost) always the QUOTE token of its pairs, never the base token.");
console.log("  /token-pairs/v1, /tokens/v1 and /latest/dex/search ALL return [] for it (verified live).");
try {
  await fetchTokenPairs(USDC);
  check("USDC: throws not-found (documented blind spot)", false, "unexpectedly returned pairs");
} catch (err) {
  console.log(`  Threw: ${err.name} kind=${err.kind} message="${err.message}"`);
  check("USDC: clean 'not-found' error (not a crash)", err.kind === "not-found");
}

// --------------------------------------------------------- (c) invalid address
console.log("\n===== (c) invalid address =====");
try {
  await fetchTokenPairs("not-an-address");
  check("invalid address: throws", false, "no error thrown");
} catch (err) {
  console.log(`  Threw: ${err.name} kind=${err.kind} message="${err.message}"`);
  check("invalid address: kind is 'invalid-address'", err.kind === "invalid-address");
}
try {
  await fetchTokenPairs("0x1234");
  check("short address: throws invalid-address", false, "no error thrown");
} catch (err) {
  check("short address: kind is 'invalid-address'", err.kind === "invalid-address");
}
check("isValidAddress rejects garbage", isValidAddress("hello") === false);
check("isValidAddress accepts MESSY", isValidAddress(MESSY) === true);

// ------------------------------------------- (d) MOCKED GoPlus honeypot payload
console.log("\n===== (d) MOCKED GoPlus honeypot (no live fetch) =====");
const mockedPairs = {
  pairs: [{ dexId: "uniswap", liquidity: { usd: 500000 }, volume: { h24: 100000 }, txns: { h24: { buys: 100, sells: 10 } }, pairCreatedAt: Date.now() - 200 * 86400000, priceUsd: "1.00", marketCap: 1000000, fdv: 1000000, baseToken: { name: "Mock", symbol: "MOCK", address: MESSY }, info: { websites: [{ url: "https://example.com" }], socials: [{ type: "twitter", url: "https://x.com/x" }] } }],
  bestPair: null,
  totalLiquidityUsd: 500000,
  totalVolumeH24: 100000,
  totalTxnsH24: { buys: 100, sells: 10 },
  pairAgeMs: 200 * 86400000,
  pairCreatedAt: Date.now() - 200 * 86400000,
  token: { name: "Mock", symbol: "MOCK", address: MESSY },
  websites: [{ url: "https://example.com" }],
  socials: [{ type: "twitter", url: "https://x.com/x" }],
  priceUsd: 1,
  marketCap: 1000000,
  fdv: 1000000,
};
const mockedGoplus = {
  available: true,
  is_honeypot: "1",
  is_open_source: "1",
  is_mintable: "0",
  hidden_owner: "0",
  owner_change_balance: "0",
  can_take_back_ownership: "0",
  selfdestruct: "0",
  is_proxy: "0",
  is_blacklisted: "0",
  trading_cooldown: "0",
  transfer_pausable: "0",
  honeypot_with_same_creator: "0",
  buy_tax: "0",
  sell_tax: "0",
  holder_count: 5000,
  lp_holder_count: 2,
  holders: Array.from({ length: 10 }, (_, i) => ({ address: `0x${String(i).padStart(40, "0")}`, percent: 0.01 })),
  top10Percent: 0.1,
  lp_holders: [{ address: "0x000000000000000000000000000000000000dead", percent: 0.9 }],
};
// Sanity: without the honeypot flag this mock would score very high.
const cleanMock = scoreToken({ pairs: mockedPairs, goplus: { ...mockedGoplus, is_honeypot: "0" } });
console.log(`  Control (same mock, is_honeypot="0"): total=${cleanMock.total} verdict=${cleanMock.verdict}`);
check("mock control scores high without honeypot flag", cleanMock.total >= 90, `total=${cleanMock.total}`);

const honey = scoreToken({ pairs: mockedPairs, goplus: mockedGoplus });
printScore("MOCKED honeypot", honey);
check("honeypot mock: verdict is RUG", honey.verdict === "RUG");
check("honeypot mock: total clamped to 0–10", honey.total >= 0 && honey.total <= 10, `total=${honey.total}`);
check(
  "honeypot mock: clamp reason recorded",
  honey.reasons.some((r) => r.text.includes("HONEYPOT") && r.text.includes("clamped")),
);

// ------------------------------------------------- (e) GoPlus-down degradation
console.log("\n===== (e) GoPlus unavailable — graceful degradation (mocked) =====");
const degraded = scoreToken({ pairs: mockedPairs, goplus: { available: false, error: "mock outage" } });
printScore("GoPlus-down mock", degraded);
check("GoPlus-down: does not throw, returns a result", typeof degraded.total === "number");
check("GoPlus-down: holder sub-score is 0 with a gap", degraded.holder === 0 && degraded.dataGaps.some((g) => g.includes("Holder data unavailable")));
check("GoPlus-down: protocol scores only Dexscreener-known signals", degraded.protocol >= 60);

console.log(`\n================ RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ================`);
process.exit(failures === 0 ? 0 : 1);
