# Messy Token Checker — Check before you buy

A free web app that checks any **Base** token contract and returns a
**SAFE / WATCH / RUG** verdict with a 0–100 score, a factor breakdown,
red flags, and a plain-language AI explanation.

Built for **#BuildHybridAI 2026** (Firebase Hybrid AI Hackathon).

> **Check before you buy.** Paste an address, get the verdict in seconds —
> no wallet, no sign-up, no API key, no fees.

## The hybrid story

The **score is computed locally** by a deterministic rule engine from live
Dexscreener + GoPlus data — same data, same score, every time. The AI is
the **explainer only**: it turns the computed metrics into a headline,
red flags, and next steps.

Two Gemini routes, one SDK — **Firebase AI Logic hybrid inference**:

| Route | When it runs | Badge |
|---|---|---|
| **On-device — Gemini Nano** (`PREFER_ON_DEVICE`) | Chrome on Desktop v139+ with the Prompt API flag and the model downloaded | 🟢 On-device · Gemini Nano |
| **In the cloud — Gemini 3.8 Flash** (automatic fallback) | Everywhere else, or while Nano is still downloading | 🔵 In the cloud · Gemini 3.8 Flash |

Every result carries a visible route badge, so you can see which path ran.
While Nano downloads, a progress bar shows the download and a
**"Use cloud meanwhile"** toggle skips straight to the cloud route.
If the AI call fails for any reason (e.g. App Check not configured yet),
the score, verdict, factors and red flags still render — the app is fully
usable without the AI, and the AI section offers a Retry button.

## How to run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build into dist/
npm run preview    # serve the production build locally
```

### On-device AI (optional, for the Nano route)

1. Chrome on **Desktop, v139+**.
2. Enable `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input`
   and restart Chrome.
3. Run a check — the app starts the one-time Nano download (a few
   hundred MB) and shows progress. The first checks fall back to cloud
   Gemini meanwhile.

### Firebase console setup (required for the cloud route)

The cloud route needs App Check + the Gemini Developer API configured in
the Firebase console. The exact ordered steps are in
[`../CONSOLE-STEPS.md`](../CONSOLE-STEPS.md) — including the reCAPTCHA
Enterprise key, App Check registration, rate limits, Hosting, and the
localhost debug-token flow. **No debug token is ever committed to this
repo** (see `.gitignore`).

Deploy:

```bash
firebase deploy --only hosting   # serves dist/ on messy-token-checker.web.app
```

## Scoring rules

Weights: **Protocol 60 / Holder 25 / Liquidity 15** (of 100).
Verdict bands: **SAFE ≥ 70 · WATCH 45–69 · RUG < 45**.

### Protocol — 60 pts (GoPlus + Dexscreener)

| Signal | Rule |
|---|---|
| Honeypot (`is_honeypot = 1`) | **Auto-RUG** — total clamped to 0–10, whatever else scores |
| Contract not verified | −15 |
| Mintable | −10 |
| Hidden owner / owner can change balances / can take back ownership | −8 each, capped −16 |
| Self-destruct / proxy | −8 / −4 |
| Blacklist / trading cooldown / pausable transfers | −5 each |
| Buy/sell tax (higher of the two) | ≤5% → −2 · 5–10% → −6 · 10–25% → −12 · >25% → −20 |
| Deployer previously deployed a honeypot | −5 — a yellow flag about the creator, **never** an auto-RUG |
| Pair age | <24h → −8 · <7d → −4 · >90d → +3 |
| No website or socials | −3 |

### Holder — 25 pts (GoPlus)

Top-10 concentration: ≤20% → 25 · 20–40% → 18 · 40–60% → 10 ·
60–80% → 5 · >80% → 0. Holder count <50 → −5, <10 → −10.
No LP holders → −5.

### Liquidity — 15 pts (Dexscreener)

Total liquidity: ≥$100k → 15 · $50–100k → 12 · $10–50k → 8 ·
$1–10k → 4 · <$1k → 0. Zero 24h volume → −3. Sell-dominated 24h
flow (>90% sells) → −3.

### Worked examples (live-verified 26 Nov 2026)

- **$MESSY** `0x09f87f948c88848363b124c9099cbb58e4cc7cb6` → **66 / WATCH**
  (Protocol 56, Holder 5, Liquidity 5 — clean contract, but top-10
  concentration is 61.8% and the day was sell-heavy).
- **BRETT** `0x532f27101965dd16442E59d40670FaF5eBB142E4` → **93 / SAFE**
  (verified, non-mintable, 0% tax, top-10 ~33%, $1.4M liquidity).

Both are one-click sample buttons in the app.

## Data sources

- **Dexscreener** — market + liquidity data, keyless and free
  (`/token-pairs/v1/base/{address}`). CORS-enabled; the live response is
  a bare JSON array, handled defensively.
- **GoPlus Security API** — contract flags, taxes, holders
  (`/token_security/8453`, Base chain id 8453). Keyless and free,
  5-minute client-side cache.

## Honest limitations

- **USDC, WETH and other quote tokens can't be checked.** Dexscreener's
  token-pairs endpoint only sees tokens that are the *base* token of a
  pair — quote tokens return no pairs at all. The UI explains this in
  the not-found error state instead of pretending the address is wrong.
- **Top-10 concentration is a proxy.** Full holder distribution is a paid
  endpoint; the UI labels the metric as what it is.
- **LP lock status can't be verified from free data.** No lock date is
  ever invented. If the top LP holder is the burn address we say so;
  otherwise the UI says it's unverifiable.
- **Ownership-renounced status can't be verified from free data.**
  Owner-risk flags are the closest proxy.
- **If GoPlus is down, a SAFE is capped at WATCH.** Without contract +
  holder data we won't call a token safe — the verdict is capped (with a
  warning banner) until the contract can be verified.
- **On-device AI needs Chrome Desktop v139+** with the Prompt API flag
  and a one-time model download. Everywhere else the cloud fallback runs.
- GoPlus rate limits are undocumented; the app caches for 5 minutes and
  degrades gracefully instead of failing the whole check.

## Project layout

```
messy-token-checker/
├── index.html                 # page shell: hero, checker, how-it-works
├── src/
│   ├── main.js                # UI wiring + check flow (user activation!)
│   ├── firebase.js            # Firebase init + App Check + AI Logic
│   ├── scoring.js             # deterministic rule engine (Protocol/Holder/Liquidity)
│   ├── data/
│   │   ├── dexscreener.js     # Dexscreener fetch + normalize
│   │   └── goplus.js          # GoPlus fetch + parse (never throws)
│   ├── ai/
│   │   ├── verdictSchema.js   # structured-output schema (both routes)
│   │   ├── prompts.js         # tiny metrics-only verdict prompt
│   │   └── hybrid.js          # PREFER_ON_DEVICE / ONLY_IN_CLOUD models, route detection
│   └── ui/
│       ├── render.js          # verdict card, factor bars, red flags, AI card, history
│       └── routeBadge.js      # On-device/Cloud badge, Nano chip, download bar
├── scripts/
│   ├── test-scoring.mjs       # live scoring tests (MESSY + BRETT + mocks)
│   ├── test-ai-imports.mjs    # AI-layer smoke tests (no browser needed)
│   ├── capture-fixtures.mjs   # re-capture the live API responses used by the QC script
│   ├── fixtures/              # captured live Dexscreener + GoPlus responses (real data)
│   └── screenshot.mjs         # Playwright visual QC (desktop + mobile)
├── firebase.json              # Hosting config (serves dist/)
├── .firebaserc                # project alias: messy-token-checker
└── README.md
```

## Tests

```bash
node scripts/test-scoring.mjs    # live Dexscreener + GoPlus + scoring (needs network)
node scripts/test-ai-imports.mjs # AI-layer smoke tests (no browser, no network)
node scripts/screenshot.mjs     # Playwright visual QC: desktop + mobile screenshots
```

`scripts/screenshot.mjs` serves the two data APIs from captured live
responses (`scripts/fixtures/`, refresh with
`node scripts/capture-fixtures.mjs`) because the sandbox browser has no
direct internet; set `SCREENSHOT_LIVE=1` to hit the live APIs instead.
Screenshots land in `screenshots/` (gitignored). The AI route badge
only appears once the Firebase console steps are done — until then the
script reports the AI card as (correctly) unavailable.

## License

Apache-2.0 — see [LICENSE](LICENSE).

Not financial advice. Always do your own research — and for the full
Messy due diligence, see [app.messyvirgo.com](https://app.messyvirgo.com).
