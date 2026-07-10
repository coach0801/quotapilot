/**
 * OpenRouter adapter — OpenAI-compatible multi-provider endpoint.
 * `:free` models: 20 RPM / 50 req-day. Sends `x-ratelimit-limit`,
 * `x-ratelimit-remaining` and an epoch-ms `x-ratelimit-reset`.
 */

import { PROVIDERS } from "@/config/providers";
import { createOpenAiCompatAdapter } from "./openai-compat";

export const openrouterAdapter = createOpenAiCompatAdapter({
  id: "openrouter",
  baseUrl: PROVIDERS.openrouter.baseUrl,
  models: () => PROVIDERS.openrouter.models,
  headers: (key) => ({
    Authorization: `Bearer ${key}`,
    // OpenRouter attribution headers (used for app rankings; optional).
    "HTTP-Referer": "https://quotapilot.vercel.app",
    "X-Title": "QuotaPilot",
  }),
});
