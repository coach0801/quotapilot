/**
 * GitHub Models adapter — OpenAI-compatible inference endpoint at
 * models.github.ai, authenticated with a GitHub PAT (models scope).
 */

import { PROVIDERS } from "@/config/providers";
import { createOpenAiCompatAdapter } from "./openai-compat";

export const githubModelsAdapter = createOpenAiCompatAdapter({
  id: "github-models",
  baseUrl: PROVIDERS["github-models"].baseUrl,
  models: () => PROVIDERS["github-models"].models,
  headers: (key) => ({
    Authorization: `Bearer ${key}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  }),
});
