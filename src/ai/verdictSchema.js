// src/ai/verdictSchema.js — Structured-output schema for the AI verdict.
//
// The SAME schema object is used on both hybrid routes (see src/ai/hybrid.js):
//  - cloud:  generationConfig { responseMimeType: "application/json", responseSchema }
//  - device: promptOptions { responseConstraint }
// so the model returns identical JSON whichever route runs.
//
// The score itself is NOT computed by the AI — it comes from the deterministic
// local scoring engine (src/scoring.js). The AI is the explainer only: it
// receives the computed metrics + score and returns plain-language text.

import { Schema } from "firebase/ai";

export const verdictSchema = Schema.object({
  properties: {
    // Must match the deterministic verdict from the scoring engine.
    verdict: Schema.enumString({ enum: ["SAFE", "WATCH", "RUG"] }),
    // Must match the computed total score (0-100).
    score: Schema.number(),
    // One plain-language sentence, e.g. "This token looks reasonably safe, but check the top holders first."
    headline: Schema.string(),
    // Concrete risks derived ONLY from the supplied metrics. Never invented.
    redFlags: Schema.array({ items: Schema.string() }),
    // 2-3 sentences explaining WHY the score is what it is.
    explanation: Schema.string(),
    // 2-4 concrete things the user should verify next.
    nextSteps: Schema.array({ items: Schema.string() }),
  },
});
