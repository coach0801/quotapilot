import { describe, expect, it } from "vitest";

import { mistralAdapter } from "@/adapters/mistral";
import fixture from "./fixtures/mistral.json";
import { runOpenAiCompatContract } from "./openai-compat.shared";

runOpenAiCompatContract(mistralAdapter, fixture, {
  content: "Bonjour from Mistral!",
  streamText: "Bonjour",
  urlIncludes: "api.mistral.ai/v1",
});

describe("mistral rate-limit header dialect", () => {
  it("parses token-budget (ratelimitbysize) headers", () => {
    const snap = mistralAdapter.parseRateLimitHeaders(
      new Headers(fixture.rateLimitHeaders),
    )!;
    expect(snap.limitTokens).toBe(500_000);
    expect(snap.remainingTokens).toBe(499_500);
    expect(snap.limitRequests).toBeUndefined();
  });
});
