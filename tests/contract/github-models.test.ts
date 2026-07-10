import { describe, expect, it, vi, afterEach } from "vitest";

import { githubModelsAdapter } from "@/adapters/github-models";
import fixture from "./fixtures/github-models.json";
import { jsonResponse, lastFetchCall, mockFetch } from "./helpers";
import { req, runOpenAiCompatContract } from "./openai-compat.shared";

runOpenAiCompatContract(githubModelsAdapter, fixture, {
  content: "Hello from GitHub Models!",
  streamText: "Hey",
  urlIncludes: "models.github.ai/inference",
});

describe("github-models specifics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the GitHub API version header", async () => {
    const spy = mockFetch(jsonResponse(fixture.chat));
    await githubModelsAdapter.chat(
      req(fixture.chat.model, false),
      "github_pat_test",
      new AbortController().signal,
    );
    const headers = lastFetchCall(spy).init.headers as Record<string, string>;
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(headers.Authorization).toBe("Bearer github_pat_test");
  });
});
