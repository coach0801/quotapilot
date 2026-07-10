/**
 * Mistral (La Plateforme) adapter — OpenAI-compatible chat endpoint.
 * Free-tier limits are token-based; Mistral reports them via
 * `x-ratelimitbysize-*` headers, handled by the common parser.
 */

import { PROVIDERS } from "@/config/providers";
import { createOpenAiCompatAdapter } from "./openai-compat";

export const mistralAdapter = createOpenAiCompatAdapter({
  id: "mistral",
  baseUrl: PROVIDERS.mistral.baseUrl,
  models: () => PROVIDERS.mistral.models,
});
