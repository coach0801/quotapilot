import { describe, expect, it } from "vitest";

import { openrouterAdapter } from "@/adapters/openrouter";
import fixture from "./fixtures/openrouter.json";
import { runOpenAiCompatContract } from "./openai-compat.shared";

runOpenAiCompatContract(openrouterAdapter, fixture, {
  content: "Hello from OpenRouter!",
  streamText: "Hi there",
  urlIncludes: "openrouter.ai/api/v1",
});

describe("openrouter rate-limit header dialect", () => {
  it("parses bare x-ratelimit-limit/remaining headers", () => {
    const snap = openrouterAdapter.parseRateLimitHeaders(
      new Headers(fixture.rateLimitHeaders),
    )!;
    expect(snap.limitRequests).toBe(20);
    expect(snap.remainingRequests).toBe(19);
  });
});
