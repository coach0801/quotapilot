/**
 * Groq adapter — OpenAI-compatible endpoint at api.groq.com.
 * Sends daily request budgets and per-minute token budgets in
 * `x-ratelimit-*` headers with duration-style reset values ("2m59.56s").
 */

import { PROVIDERS } from "@/config/providers";
import { createOpenAiCompatAdapter } from "./openai-compat";

export const groqAdapter = createOpenAiCompatAdapter({
  id: "groq",
  baseUrl: PROVIDERS.groq.baseUrl,
  models: () => PROVIDERS.groq.models,
});
