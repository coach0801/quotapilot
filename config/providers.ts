/**
 * Provider defaults: rate limits, model catalog, model classes.
 *
 * ⚠️ Limits verified against provider docs: 2026-07-10 (spec §3.1).
 *    Re-verify at kickoff — free tiers change without notice.
 *
 * These are DEFAULTS only. Adapters parse live rate-limit response headers
 * where available and the gateway updates Redis counters from them, so a
 * provider changing its limits degrades gracefully instead of breaking.
 */

import type { ProviderConfig, ProviderId } from "@/core/types";

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  groq: {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    // 30 RPM, ~14,400 req/day, 6,000 TPM on small models (verified 2026-07-10)
    limits: { rpm: 30, rpd: 14_400, tpm: 6_000 },
    models: [
      { id: "llama-3.3-70b-versatile", modelClass: "strong", contextWindow: 128_000 },
      { id: "meta-llama/llama-4-scout-17b-16e-instruct", modelClass: "fast", contextWindow: 128_000 },
      { id: "qwen/qwen3-32b", modelClass: "reasoning", contextWindow: 128_000 },
      { id: "openai/gpt-oss-120b", modelClass: "reasoning", contextWindow: 128_000 },
      { id: "openai/gpt-oss-20b", modelClass: "fast", contextWindow: 128_000 },
    ],
    demoKeyEnv: "DEMO_GROQ_KEY",
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    // 5–15 RPM, 20–1,500 req/day per model — conservative defaults (verified 2026-07-10)
    limits: { rpm: 10, rpd: 250, tpm: 250_000 },
    models: [
      { id: "gemini-2.5-flash", modelClass: "strong", contextWindow: 1_000_000 },
      { id: "gemini-2.5-flash-lite", modelClass: "fast", contextWindow: 1_000_000 },
    ],
    demoKeyEnv: "DEMO_GEMINI_KEY",
  },
  mistral: {
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    // ~1 req/s, ~500,000 TPM, ~1B tokens/mo on the free tier (verified 2026-07-10)
    limits: { rpm: 60, rpd: 20_000, tpm: 500_000 },
    models: [
      { id: "mistral-small-latest", modelClass: "fast", contextWindow: 128_000 },
      { id: "mistral-medium-latest", modelClass: "strong", contextWindow: 128_000 },
      { id: "magistral-small-latest", modelClass: "reasoning", contextWindow: 40_000 },
      { id: "devstral-small-latest", modelClass: "fast", contextWindow: 128_000 },
    ],
    demoKeyEnv: "DEMO_MISTRAL_KEY",
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    // 20 RPM, 50 req/day (1,000/day after one-time $10 top-up) (verified 2026-07-10)
    limits: { rpm: 20, rpd: 50, tpm: 1_000_000 },
    models: [
      { id: "meta-llama/llama-3.3-70b-instruct:free", modelClass: "strong", contextWindow: 128_000 },
      { id: "mistralai/mistral-small-3.2-24b-instruct:free", modelClass: "fast", contextWindow: 96_000 },
      { id: "deepseek/deepseek-r1:free", modelClass: "reasoning", contextWindow: 128_000 },
    ],
    demoKeyEnv: "DEMO_OPENROUTER_KEY",
  },
  "github-models": {
    id: "github-models",
    name: "GitHub Models",
    baseUrl: "https://models.github.ai/inference",
    // 15 RPM, 150–1,000 req/day depending on model tier (verified 2026-07-10)
    limits: { rpm: 15, rpd: 150, tpm: 60_000 },
    models: [
      { id: "openai/gpt-4o", modelClass: "strong", contextWindow: 128_000 },
      { id: "openai/gpt-4o-mini", modelClass: "fast", contextWindow: 128_000 },
      { id: "meta/llama-3.3-70b-instruct", modelClass: "strong", contextWindow: 128_000 },
      { id: "microsoft/phi-4", modelClass: "fast", contextWindow: 16_000 },
    ],
    demoKeyEnv: "DEMO_GITHUB_TOKEN",
  },
};

export const PROVIDER_LIST: ProviderConfig[] = Object.values(PROVIDERS);

/** Providers ordered by descending reliability — used as the routing tiebreak. */
export const RELIABILITY_ORDER: ProviderId[] = [
  "groq",
  "gemini",
  "mistral",
  "openrouter",
  "github-models",
];

export function demoKeyFor(id: ProviderId): string | undefined {
  const v = process.env[PROVIDERS[id].demoKeyEnv];
  return v && v.length > 0 ? v : undefined;
}

/** Demo-pool key set from env (playground traffic). Missing keys are skipped. */
export function demoKeySet(): Partial<Record<ProviderId, string>> {
  const out: Partial<Record<ProviderId, string>> = {};
  for (const p of PROVIDER_LIST) {
    const key = demoKeyFor(p.id);
    if (key) out[p.id] = key;
  }
  return out;
}
