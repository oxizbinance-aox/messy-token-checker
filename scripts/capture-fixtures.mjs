/**
 * Capture live API fixtures for the Playwright visual-QC script.
 *
 * The sandbox browser (Playwright Chromium) cannot reach the internet:
 * the VM's egress is a MITM proxy (Hatch Sandbox Egress CA) that curl /
 * Node can use, but Chromium's CONNECT to it never gets a response
 * (ERR_TUNNEL_CONNECTION_FAILED in every proxy configuration tried —
 * env proxy, explicit --proxy-server, Playwright proxy option, literal
 * IPv6 proxy, host-resolver MAP rules, --ignore-certificate-errors).
 * Node's fetch works fine through the same proxy, so fixtures are
 * captured here with Node and served to the browser by Playwright's
 * route interception (scripts/screenshot.mjs).
 *
 * These are REAL responses from the live APIs, captured 26 Nov 2026 —
 * not hand-written mocks. Re-run to refresh:
 *
 *   node scripts/capture-fixtures.mjs
 *
 * Files: scripts/fixtures/dexscreener-<token>.json (bare array of pairs,
 * exactly as the live endpoint returns) and goplus-<token>.json
 * (the {code, message, result} envelope, keyed by lowercase address).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "fixtures");
fs.mkdirSync(dir, { recursive: true });

const TOKENS = {
  messy: "0x09f87f948c88848363b124c9099cbb58e4cc7cb6",
  brett: "0x532f27101965dd16442E59d40670FaF5eBB142E4",
};

async function fetchJson(url, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return res.json();
}

for (const [name, address] of Object.entries(TOKENS)) {
  const dex = await fetchJson(
    `https://api.dexscreener.com/token-pairs/v1/base/${address}`,
    `dexscreener ${name}`,
  );
  const dexFile = path.join(dir, `dexscreener-${name}.json`);
  fs.writeFileSync(dexFile, JSON.stringify(dex));
  console.log(
    `wrote ${dexFile} (${Array.isArray(dex) ? dex.length : "?"} pairs)`,
  );

  const gp = await fetchJson(
    `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${address.toLowerCase()}`,
    `goplus ${name}`,
  );
  const gpFile = path.join(dir, `goplus-${name}.json`);
  fs.writeFileSync(gpFile, JSON.stringify(gp));
  console.log(
    `wrote ${gpFile} (code=${gp.code}, token=${gp.result?.[address.toLowerCase()]?.token_symbol ?? "?"})`,
  );
}

console.log("fixtures captured.");
