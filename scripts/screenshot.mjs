/**
 * Visual QC for Messy Token Checker — Playwright.
 *
 * Starts `vite preview` (production build), then in a real Chromium:
 *  - desktop 1440x900: empty state + completed $MESSY check
 *  - mobile 390x844: empty state + completed $MESSY check
 *  - invalid-address error state
 *
 * Assertions (hard failures → exit 1):
 *  - the $MESSY result renders (score dial + verdict + factor bars)
 *  - no horizontal overflow at 390px
 *  - the invalid-address error state renders
 *
 * Route badge: reported, not hard-failed. The AI call needs the Firebase
 * console steps (CONSOLE-STEPS.md — App Check / reCAPTCHA) to succeed;
 * until those are done the AI card correctly shows "unavailable" and no
 * badge is rendered. The script prints which case it saw.
 *
 * NETWORK MODE — fixtures by default, live on request:
 * This sandbox's browser cannot reach the internet at all: the VM's
 * egress is a MITM proxy (Hatch Sandbox Egress CA) that curl and Node
 * can use, but Chromium's CONNECT to it never gets a response
 * (ERR_TUNNEL_CONNECTION_FAILED in every configuration tried — env
 * proxy, explicit --proxy-server, Playwright proxy option, literal
 * IPv6 proxy, host-resolver MAP rules, --ignore-certificate-errors).
 * So by default the script intercepts the two data-API requests and
 * serves REAL responses captured live with Node (scripts/fixtures/,
 * via scripts/capture-fixtures.mjs — re-run it to refresh). The
 * click → fetch → score → render flow in the browser is fully real;
 * only the transport is stubbed, with real data. The live API path
 * itself is proven separately by `node scripts/test-scoring.mjs`
 * (Node fetch, real network, green).
 * Set SCREENSHOT_LIVE=1 to skip interception and hit the live APIs
 * (works on any machine whose browser has direct internet).
 *
 * Playwright itself is NOT a project dependency (the repo stays free of
 * dev-only weight): the script resolves it from the npx cache
 * (~/.npm/_npx/HASH/node_modules/playwright, populated by
 * `npx playwright install chromium`) or from a bare `playwright` import
 * if it is installed somewhere on the path.
 *
 * Run from the project dir:  node scripts/screenshot.mjs
 * Screenshots land in screenshots/ (gitignored).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const shotsDir = path.join(root, "screenshots");
const PREVIEW_PORT = 4173;
const BASE_URL = `http://localhost:${PREVIEW_PORT}`;
const MESSY = "0x09f87f948c88848363b124c9099cbb58e4cc7cb6";
const BRETT = "0x532f27101965dd16442E59d40670FaF5eBB142E4";
const LIVE = process.env.SCREENSHOT_LIVE === "1";

/** Load the captured live fixtures (see scripts/capture-fixtures.mjs). */
function loadFixtures() {
  const read = (name) =>
    fs.readFileSync(path.join(here, "fixtures", name), "utf8");
  return {
    dexscreener: {
      [MESSY.toLowerCase()]: read("dexscreener-messy.json"),
      [BRETT.toLowerCase()]: read("dexscreener-brett.json"),
    },
    goplus: {
      [MESSY.toLowerCase()]: read("goplus-messy.json"),
      [BRETT.toLowerCase()]: read("goplus-brett.json"),
    },
  };
}

/**
 * Intercept the two data-API hosts and serve the captured live fixtures.
 * Firebase / Google requests are NOT intercepted — in this sandbox they
 * fail (no browser egress), which is exactly the AI-unavailable path
 * the app must handle; on a machine with internet they go live.
 *
 * The GoPlus response is delayed ~2.5s on purpose so the loading state
 * (steps ticking, Cancel button) is observable mid-check instead of
 * flashing past — the fetches run in parallel, so the Dexscreener step
 * resolves instantly while GoPlus is still "active".
 */
async function installFixtureRoutes(page, fixtures) {
  await page.route("**/api.dexscreener.com/token-pairs/v1/base/*", (route) => {
    const addr = route.request().url().split("/").pop().toLowerCase();
    const body = fixtures.dexscreener[addr];
    if (body) {
      route.fulfill({ status: 200, contentType: "application/json", body });
    } else {
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
  });
  await page.route("**/api.gopluslabs.io/api/v1/token_security/8453*", async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    const addr = new URL(route.request().url()).searchParams
      .get("contract_addresses")
      ?.toLowerCase();
    const body = fixtures.goplus[addr ?? ""];
    if (body) {
      route.fulfill({ status: 200, contentType: "application/json", body });
    } else {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ code: 1, message: "OK", result: {} }),
      });
    }
  });
}

const failures = [];
const notes = [];
const check = (label, ok, extra = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures.push(label);
};
const note = (label, extra = "") => {
  console.log(`  NOTE  ${label}${extra ? ` — ${extra}` : ""}`);
  notes.push(label);
};

/** Resolve the playwright package without it being a project dependency. */
async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    // Fall back to the npx cache populated by `npx playwright install chromium`.
    const npxRoot = path.join(
      process.env.HOME ?? "~",
      ".npm",
      "_npx",
    );
    const candidates = [];
    try {
      for (const dir of fs.readdirSync(npxRoot)) {
        const p = path.join(npxRoot, dir, "node_modules", "playwright");
        if (fs.existsSync(path.join(p, "package.json"))) candidates.push(p);
      }
    } catch {
      // no npx cache — fall through to the error below
    }
    for (const p of candidates) {
      try {
        return await import(pathToFileURL(path.join(p, "index.mjs")).href);
      } catch {
        // try the next candidate
      }
    }
    throw new Error(
      "Playwright package not found. Run `npx playwright install chromium` first " +
        "(it downloads the playwright package into the npx cache).",
    );
  }
}

function waitForPreview(timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(BASE_URL);
        if (res.ok) return resolve();
      } catch {
        // not up yet
      }
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`vite preview did not come up on ${BASE_URL}`));
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

const { chromium } = await loadPlaywright();
fs.mkdirSync(shotsDir, { recursive: true });

// --- start vite preview (serves the production build in dist/) ---
const preview = spawn("npm", ["run", "preview", "--", "--port", String(PREVIEW_PORT), "--strictPort"], {
  cwd: root,
  stdio: "ignore",
});
let previewDead = false;
preview.on("exit", () => {
  previewDead = true;
});

try {
  await waitForPreview();
  console.log(`vite preview up at ${BASE_URL}`);

  // ======================================================= DESKTOP 1440x900
  const fixtures = LIVE ? null : loadFixtures();
  console.log(`network mode: ${LIVE ? "LIVE (real APIs)" : "FIXTURES (captured live responses)"}`);
  const desktop = await chromium.launch();
  const dPage = await desktop.newPage({ viewport: { width: 1440, height: 900 } });
  if (fixtures) await installFixtureRoutes(dPage, fixtures);
  dPage.on("pageerror", (err) => note("desktop pageerror", String(err).slice(0, 200)));
  await dPage.goto(BASE_URL, { waitUntil: "networkidle" });
  await dPage.waitForSelector(".hero h1", { timeout: 10000 });
  check("desktop: hero renders", true);
  await dPage.screenshot({ path: path.join(shotsDir, "desktop-empty.png") });
  console.log("  shot  screenshots/desktop-empty.png");

  // Click "Try $MESSY" and wait for the result.
  await dPage.click(`.sample-btn[data-address="${MESSY}"]`);
  // Loading state (GoPlus fixture is delayed ~2.5s, so this is observable):
  // Cancel must be visible without scrolling, and both data steps must
  // show as in-progress while the fetches run (26 Nov 2026: the button
  // was below the fold and the steps never ticked).
  const cancelBtn = dPage.locator('[data-action="cancel-check"]');
  await cancelBtn.waitFor({ state: "visible", timeout: 5000 });
  const cancelBox = await cancelBtn.boundingBox();
  check(
    "desktop: Cancel button visible without scrolling",
    !!cancelBox && cancelBox.y >= 0 && cancelBox.y + cancelBox.height <= 900,
    cancelBox ? `y=${Math.round(cancelBox.y)} h=${Math.round(cancelBox.height)}` : "no bounding box",
  );
  check(
    "desktop: loading steps tick while fetching",
    (await dPage.locator('.loading-steps li[data-step="dexscreener"].is-active').count()) === 1 &&
      (await dPage.locator('.loading-steps li[data-step="goplus"].is-active').count()) === 1,
  );
  await dPage.waitForSelector(".result", { timeout: 120000 });
  await dPage.waitForTimeout(1500); // let the dial/bar animations settle
  const dVerdict = (await dPage.textContent(".dial-verdict-label"))?.trim();
  const dScore = (await dPage.textContent(".dial-score"))?.trim();
  check("desktop: $MESSY result renders", true, `score ${dScore}, verdict ${dVerdict}`);
  check("desktop: $MESSY verdict is WATCH", dVerdict === "WATCH", `got ${dVerdict}`);
  check(
    "desktop: factor bars render (3 factors)",
    (await dPage.locator(".factor").count()) === 3,
  );
  // Factors subtitle must show EARNED points, not maxima (26 Nov 2026:
  // BRETT showed "Holder 25" = max, not the earned 18, so 60+25+15=100
  // while the score was 93).
  const dSubtitle =
    (await dPage.locator(".factors .section-sub").first().textContent())?.trim() ?? "";
  const dFactorScores = await dPage.locator(".factor-score").allTextContents();
  const dEarned = dFactorScores.map((t) => Number(t.split("/")[0].trim()));
  const dSubNums = [...dSubtitle.matchAll(/(\d+)/g)].map((m) => Number(m[1]));
  check(
    "desktop: factors subtitle shows earned points",
    dSubNums.length === 5 &&
      dSubNums[0] === dEarned[0] &&
      dSubNums[1] === dEarned[1] &&
      dSubNums[2] === dEarned[2] &&
      dSubNums[3] === Number(dScore) &&
      dSubNums[4] === 100,
    `subtitle "${dSubtitle}" vs factors ${dEarned.join("+")} total ${dScore}`,
  );
  const dBadge = await dPage.locator(".route-badge").count();
  const dAiUnavailable = await dPage.locator(".ai-unavailable").count();
  if (dBadge > 0) {
    const badgeText = (await dPage.locator(".route-badge").first().textContent())?.trim();
    note("desktop: route badge present", badgeText);
  } else if (dAiUnavailable > 0) {
    note(
      "desktop: no route badge — AI unavailable (EXPECTED until the Firebase console steps are done; see CONSOLE-STEPS.md)",
    );
  } else {
    check("desktop: route badge present", false, "no badge and no unavailable card");
  }
  // AI diagnostics block (round 4): the cloud browser cannot open
  // DevTools, so the [ai-timing] lines must be readable IN THE PAGE.
  // In this sandbox the AI call fails (no browser egress to Google), so
  // the block sits in the AI-unavailable card and must show the stall.
  const dDiag = dPage.locator('[data-testid="ai-diagnostics"]');
  check(
    "desktop: AI diagnostics block present in the AI card",
    (await dDiag.count()) === 1,
  );
  const dDiagText = (await dDiag.first().textContent()) ?? "";
  check(
    "desktop: diagnostics block shows the summary label",
    dDiagText.includes("AI diagnostics"),
  );
  check(
    "desktop: diagnostics block shows [ai-timing] lines incl. the App Check phase",
    dDiagText.includes("[ai-timing") && dDiagText.includes("appcheck:getToken"),
    dDiagText.slice(0, 160).replace(/\s+/g, " "),
  );
  check(
    "desktop: diagnostics block names the stalled phase on failure",
    dDiagText.includes("stalled at:"),
    dDiagText.slice(0, 160).replace(/\s+/g, " "),
  );
  await dPage.screenshot({
    path: path.join(shotsDir, "desktop-messy.png"),
    fullPage: true,
  });
  console.log("  shot  screenshots/desktop-messy.png");
  await desktop.close();

  // ======================================================== MOBILE 390x844
  const mobile = await chromium.launch();
  const mPage = await mobile.newPage({ viewport: { width: 390, height: 844 } });
  if (fixtures) await installFixtureRoutes(mPage, fixtures);
  mPage.on("pageerror", (err) => note("mobile pageerror", String(err).slice(0, 200)));
  await mPage.goto(BASE_URL, { waitUntil: "networkidle" });
  await mPage.waitForSelector(".hero h1", { timeout: 10000 });
  await mPage.screenshot({ path: path.join(shotsDir, "mobile-empty.png") });
  console.log("  shot  screenshots/mobile-empty.png");

  await mPage.click(`.sample-btn[data-address="${MESSY}"]`);
  await mPage.waitForSelector(".result", { timeout: 120000 });
  await mPage.waitForTimeout(1500);
  const overflow = await mPage.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  check(
    "mobile: no horizontal overflow at 390px",
    overflow.scrollWidth <= overflow.innerWidth,
    `scrollWidth=${overflow.scrollWidth} innerWidth=${overflow.innerWidth}`,
  );
  const mVerdict = (await mPage.textContent(".dial-verdict-label"))?.trim();
  check("mobile: $MESSY result renders", mVerdict === "WATCH", `verdict ${mVerdict}`);
  // AI diagnostics block (round 4) must render on mobile too.
  check(
    "mobile: AI diagnostics block present in the AI card",
    (await mPage.locator('[data-testid="ai-diagnostics"]').count()) === 1,
  );
  await mPage.screenshot({
    path: path.join(shotsDir, "mobile-messy.png"),
    fullPage: true,
  });
  console.log("  shot  screenshots/mobile-messy.png");

  // Invalid-address error state (mobile viewport, same page).
  await mPage.fill("#address-input", "not-an-address");
  await mPage.click("#check-btn");
  await mPage.waitForSelector(".state-error", { timeout: 10000 });
  check("mobile: invalid-address error state renders", true);
  await mPage.screenshot({ path: path.join(shotsDir, "mobile-error.png") });
  console.log("  shot  screenshots/mobile-error.png");
  await mobile.close();
} finally {
  if (!previewDead) preview.kill("SIGTERM");
}

console.log(
  `\n================ RESULT: ${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} CHECK(S) FAILED: ${failures.join("; ")}`} ================`,
);
process.exit(failures.length === 0 ? 0 : 1);
