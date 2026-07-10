/** Adapter registry — one entry per provider (spec §4.1 contract). */

import type { ProviderAdapter, ProviderId } from "@/core/types";
import { geminiAdapter } from "./gemini";
import { githubModelsAdapter } from "./github-models";
import { groqAdapter } from "./groq";
import { mistralAdapter } from "./mistral";
import { openrouterAdapter } from "./openrouter";

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  groq: groqAdapter,
  gemini: geminiAdapter,
  mistral: mistralAdapter,
  openrouter: openrouterAdapter,
  "github-models": githubModelsAdapter,
};

export function adapterFor(id: ProviderId): ProviderAdapter {
  return ADAPTERS[id];
}
