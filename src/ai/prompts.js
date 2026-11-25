// src/ai/prompts.js — Prompts for the AI verdict explainer.
//
// The AI is the EXPLAINER, not the scorer. The deterministic local engine
// (src/scoring.js) already computed the metrics, sub-scores, total and
// verdict from Dexscreener + GoPlus data. The prompt only hands those
// computed facts to the model and asks for plain-language JSON text.
//
// Keep prompts TINY: Gemini Nano (on-device) has a small context window,
// so only the numbers that matter are sent — no raw API payloads.

/**
 * Build the verdict prompt for one token check.
 *
 * @param {object} input
 * @param {object|string} input.token
 *   Token identity: { symbol, name, address } (or a plain address string).
 * @param {object} [input.metrics]
 *   Computed metrics + sub-scores from the scoring engine, e.g.
 *   { protocol: 42, holder: 18, liquidity: 12, reasons: [...],
 *     top10ConcentrationPct, holderCount, liquidityUsd, buyTaxPct, ... }.
 *   Any extra fields are passed through verbatim (JSON, compact).
 * @param {object|number} input.score
 *   Computed result: { total, verdict } (or a plain total number, in which
 *   case `verdict` is derived from the standard bands: >=70 SAFE,
 *   45-69 WATCH, <45 RUG).
 * @returns {string} A short English prompt for generateContent().
 */
export function buildVerdictPrompt({ token, metrics = {}, score }) {
  if (!token) throw new Error("[prompts] buildVerdictPrompt: token is required.");
  if (score === undefined || score === null) {
    throw new Error("[prompts] buildVerdictPrompt: score is required.");
  }

  const symbol =
    typeof token === "string" ? token : token.symbol || token.name || "UNKNOWN";
  const name = typeof token === "string" ? "" : token.name || "";
  const address = typeof token === "string" ? token : token.address || "";

  const total =
    typeof score === "number" ? score : score.total ?? score.score;
  if (typeof total !== "number" || Number.isNaN(total)) {
    throw new Error("[prompts] buildVerdictPrompt: score.total must be a number.");
  }
  const verdict =
    (typeof score === "object" && score.verdict) ||
    (total >= 70 ? "SAFE" : total >= 45 ? "WATCH" : "RUG");

  // Compact metrics only — no raw API payloads, to stay inside Nano's window.
  const metricsJson = JSON.stringify(metrics);

  return [
    `Token: ${symbol}${name && name !== symbol ? ` (${name})` : ""}` +
      (address ? ` — ${address}` : ""),
    `Computed safety score: ${total}/100. Verdict: ${verdict}.`,
    `Sub-scores and metrics: ${metricsJson}`,
    `Explain this result as JSON matching the schema. Rules:`,
    `- headline: one plain-language sentence.`,
    `- redFlags: concrete risks from the metrics ONLY. Do not invent risks.`,
    `- explanation: 2-3 sentences explaining WHY the score is ${total}.`,
    `- nextSteps: 2-4 concrete things the user should verify next.`,
    `- No financial advice. No price predictions.`,
  ].join("\n");
}
