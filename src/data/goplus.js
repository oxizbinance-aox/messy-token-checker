/**
 * GoPlus Security API data layer — Messy Token Checker.
 *
 * Keyless, free, CORS-enabled (`access-control-allow-origin: *`, live-verified
 * in RESEARCH.md §6b). No API key. Browser-compatible ESM (only global
 * `fetch` is used, so it also runs under Node 18+).
 *
 * Design rule (RESEARCH.md §6b): this module NEVER throws for fetch
 * failures — the UI must degrade gracefully, so any network / HTTP /
 * rate-limit / malformed-response problem returns
 * `{ available: false, error: <message> }` instead.
 *
 * 5-minute in-memory cache per (lowercased) address, via a Map.
 * GoPlus rate limits are undocumented, so caching + graceful degradation
 * are the mitigation (RESEARCH.md §6d gap 4).
 */

const API_BASE = "https://api.gopluslabs.io/api/v1/token_security/8453"; // 8453 = Base
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** address (lowercased) -> { data, fetchedAt } */
const cache = new Map();

/** Test/support helper: drop all cached GoPlus results. */
export function clearGoPlusCache() {
  cache.clear();
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetch GoPlus token-security data for a Base token.
 *
 * @param {string} address - token contract address (lowercased internally;
 *   GoPlus keys its `result` object by the lowercased address)
 * @returns {Promise<object>} On success `{ available: true, ...parsed }`;
 *   on ANY failure `{ available: false, error: <message> }` — never throws
 *   for fetch/HTTP/parse problems.
 *
 * Parsed success shape (raw GoPlus flags are "0"/"1" strings; taxes and
 * holder percents are decimal strings, e.g. "0.049" = 4.9%):
 * {
 *   available: true, address, token_name, token_symbol, total_supply,
 *   is_honeypot, is_open_source, is_mintable, hidden_owner,
 *   owner_change_balance, can_take_back_ownership, selfdestruct, is_proxy,
 *   is_blacklisted, trading_cooldown, transfer_pausable,
 *   honeypot_with_same_creator, is_airdrop_scam, is_anti_whale, external_call,
 *   buy_tax, sell_tax,            // decimal strings as returned, or null
 *   holder_count, lp_holder_count, // numbers, or null
 *   holders: [{address, percent}], // top-10, percent as a number 0..1
 *   top10Percent: number|null,      // sum of holders[].percent
 *   lp_holders: [{address, percent}],
 *   owner_address, creator_address, trust_list,
 *   raw,                           // the untouched GoPlus entry
 * }
 */
export async function fetchTokenSecurity(address) {
  const key = typeof address === "string" ? address.toLowerCase() : "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(key)) {
    return { available: false, error: `Invalid token address: ${String(address)}` };
  }

  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  let res;
  try {
    res = await fetch(`${API_BASE}?contract_addresses=${key}`);
  } catch (err) {
    return { available: false, error: `GoPlus request failed: ${err?.message ?? String(err)}` };
  }

  if (!res.ok) {
    if (res.status === 429) {
      return { available: false, error: "GoPlus rate-limited (HTTP 429) — security data temporarily unavailable" };
    }
    return { available: false, error: `GoPlus HTTP ${res.status} — security data temporarily unavailable` };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return { available: false, error: `GoPlus returned invalid JSON: ${err?.message ?? String(err)}` };
  }

  if (data?.code !== 1) {
    return {
      available: false,
      error: `GoPlus error: ${data?.message ?? "unknown error"} (code ${data?.code ?? "?"})`,
    };
  }

  const entry = data?.result?.[key];
  if (!entry || typeof entry !== "object") {
    return { available: false, error: "GoPlus returned no security data for this address" };
  }

  const holdersRaw = Array.isArray(entry.holders) ? entry.holders : [];
  const holders = holdersRaw.map((h) => ({
    address: h?.address ?? null,
    percent: toNum(h?.percent) ?? 0,
  }));
  const top10Percent =
    holders.length > 0 ? holders.reduce((s, h) => s + (h.percent ?? 0), 0) : null;

  const lpHoldersRaw = Array.isArray(entry.lp_holders) ? entry.lp_holders : [];
  const lp_holders = lpHoldersRaw.map((h) => ({
    address: h?.address ?? null,
    percent: toNum(h?.percent),
    // GoPlus LP-holder entries sometimes carry these; keep them when present.
    ...(h?.is_locked !== undefined ? { is_locked: h.is_locked } : {}),
    ...(h?.tag !== undefined ? { tag: h.tag } : {}),
  }));

  const parsed = {
    available: true,
    address: key,
    token_name: entry.token_name ?? null,
    token_symbol: entry.token_symbol ?? null,
    total_supply: entry.total_supply ?? null,
    // Risk flags — kept as the raw "0"/"1" strings GoPlus returns (null if absent).
    is_honeypot: entry.is_honeypot ?? null,
    is_open_source: entry.is_open_source ?? null,
    is_mintable: entry.is_mintable ?? null,
    hidden_owner: entry.hidden_owner ?? null,
    owner_change_balance: entry.owner_change_balance ?? null,
    can_take_back_ownership: entry.can_take_back_ownership ?? null,
    selfdestruct: entry.selfdestruct ?? null,
    is_proxy: entry.is_proxy ?? null,
    is_blacklisted: entry.is_blacklisted ?? null,
    trading_cooldown: entry.trading_cooldown ?? null,
    transfer_pausable: entry.transfer_pausable ?? null,
    honeypot_with_same_creator: entry.honeypot_with_same_creator ?? null,
    is_airdrop_scam: entry.is_airdrop_scam ?? null,
    is_anti_whale: entry.is_anti_whale ?? null,
    external_call: entry.external_call ?? null,
    // Taxes — decimal strings as returned ("0.049" = 4.9%), or null.
    buy_tax: entry.buy_tax ?? null,
    sell_tax: entry.sell_tax ?? null,
    holder_count: toInt(entry.holder_count),
    lp_holder_count: toInt(entry.lp_holder_count),
    holders,
    top10Percent,
    lp_holders,
    owner_address: entry.owner_address ?? null,
    creator_address: entry.creator_address ?? null,
    trust_list: entry.trust_list ?? null,
    raw: entry,
  };

  cache.set(key, { data: parsed, fetchedAt: Date.now() });
  return parsed;
}
