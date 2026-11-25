/**
 * Dexscreener data layer — Messy Token Checker.
 *
 * Keyless, free, CORS-enabled (`access-control-allow-origin: *`, live-verified
 * in RESEARCH.md §6a). No API key, no proxy. Browser-compatible ESM
 * (only global `fetch` is used, so it also runs under Node 18+).
 *
 * RESEARCH.md §6a shape warning: the live `/token-pairs/v1/base/<addr>`
 * response is a TOP-LEVEL JSON ARRAY of pairs, while the docs' schema shows
 * `{"pairs": [...]}`. Both shapes are handled here.
 */

import { fetchWithTimeout, TimeoutError } from "./http.js";

const API_BASE = "https://api.dexscreener.com/token-pairs/v1/base";

/** A Dexscreener request is abandoned after this long (live test, 26 Nov 2026: a BRETT check hung 3.5+ min with no timeout). */
export const DEXSCREENER_TIMEOUT_MS = 20_000;

/** Typed error: `.kind` is one of 'invalid-address' | 'not-found' | 'network' | 'rate-limit' | 'timeout'. */
export class DexscreenerError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "DexscreenerError";
    this.kind = kind;
  }
}

/** True for a well-formed EVM address: `0x` + 40 hex chars. */
export function isValidAddress(addr) {
  return typeof addr === "string" && /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Fetch all Dexscreener pairs for a Base token and normalise them.
 *
 * @param {string} address - token contract address (any case; checksummed or not)
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] — external abort (the check's Cancel button)
 * @returns {Promise<{
 *   pairs: object[], bestPair: object, totalLiquidityUsd: number,
 *   totalVolumeH24: number, totalTxnsH24: {buys:number, sells:number},
 *   pairAgeMs: number|null, pairCreatedAt: number|null,
 *   token: {name:string|null, symbol:string|null, address:string},
 *   websites: object[], socials: object[],
 *   priceUsd: number|null, marketCap: number|null, fdv: number|null
 * }>}
 * @throws {DexscreenerError} with .kind 'invalid-address' | 'not-found' | 'network' | 'rate-limit' | 'timeout'
 */
export async function fetchTokenPairs(address, { signal } = {}) {
  if (!isValidAddress(address)) {
    throw new DexscreenerError(
      "invalid-address",
      `Invalid token address: ${String(address)} (expected 0x + 40 hex chars)`,
    );
  }

  let res;
  try {
    res = await fetchWithTimeout(`${API_BASE}/${address}`, {
      timeoutMs: DEXSCREENER_TIMEOUT_MS,
      signal,
    });
  } catch (err) {
    if (err instanceof TimeoutError) {
      throw new DexscreenerError(
        "timeout",
        `Dexscreener did not answer within ${DEXSCREENER_TIMEOUT_MS / 1000}s — the data source is slow or unreachable right now`,
      );
    }
    throw new DexscreenerError(
      "network",
      `Dexscreener request failed: ${err?.message ?? String(err)}`,
    );
  }

  if (!res.ok) {
    if (res.status === 429) {
      throw new DexscreenerError(
        "rate-limit",
        "Dexscreener rate limit hit (HTTP 429) — try again in a minute",
      );
    }
    if (res.status === 404) {
      throw new DexscreenerError("not-found", `No Dexscreener pairs for ${address} (HTTP 404)`);
    }
    throw new DexscreenerError("network", `Dexscreener HTTP ${res.status}`);
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new DexscreenerError("network", `Dexscreener returned invalid JSON: ${err?.message ?? String(err)}`);
  }

  // Handle BOTH live shapes: bare array OR {"pairs": [...]}.
  const pairs = Array.isArray(data) ? data : Array.isArray(data?.pairs) ? data.pairs : [];
  if (pairs.length === 0) {
    throw new DexscreenerError(
      "not-found",
      `No trading pairs found for ${address} on Base (Dexscreener returned no pairs)`,
    );
  }

  // Best pair = highest liquidity.usd.
  let bestPair = pairs[0];
  let bestLiquidity = toNum(bestPair?.liquidity?.usd);
  for (const p of pairs) {
    const liq = toNum(p?.liquidity?.usd);
    if (liq > bestLiquidity) {
      bestLiquidity = liq;
      bestPair = p;
    }
  }

  const totalLiquidityUsd = pairs.reduce((s, p) => s + toNum(p?.liquidity?.usd), 0);
  const totalVolumeH24 = pairs.reduce((s, p) => s + toNum(p?.volume?.h24), 0);
  const totalTxnsH24 = pairs.reduce(
    (acc, p) => ({
      buys: acc.buys + toNum(p?.txns?.h24?.buys),
      sells: acc.sells + toNum(p?.txns?.h24?.sells),
    }),
    { buys: 0, sells: 0 },
  );

  const pairCreatedAt =
    Number.isFinite(Number(bestPair?.pairCreatedAt)) ? Number(bestPair.pairCreatedAt) : null;
  const pairAgeMs = pairCreatedAt === null ? null : Date.now() - pairCreatedAt;

  const baseToken = bestPair?.baseToken ?? {};
  const info = bestPair?.info ?? {};

  return {
    pairs,
    bestPair,
    totalLiquidityUsd,
    totalVolumeH24,
    totalTxnsH24,
    pairAgeMs,
    pairCreatedAt,
    token: {
      name: baseToken.name ?? null,
      symbol: baseToken.symbol ?? null,
      address: baseToken.address ?? address,
    },
    websites: Array.isArray(info.websites) ? info.websites : [],
    socials: Array.isArray(info.socials) ? info.socials : [],
    priceUsd: bestPair?.priceUsd != null ? toNum(bestPair.priceUsd) : null,
    marketCap: bestPair?.marketCap != null ? toNum(bestPair.marketCap) : null,
    fdv: bestPair?.fdv != null ? toNum(bestPair.fdv) : null,
  };
}
