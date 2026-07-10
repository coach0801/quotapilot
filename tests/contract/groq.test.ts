import { describe, expect, it } from "vitest";

import { groqAdapter } from "@/adapters/groq";
import fixture from "./fixtures/groq.json";
import { runOpenAiCompatContract } from "./openai-compat.shared";

runOpenAiCompatContract(groqAdapter, fixture, {
  content: "Hello from Groq!",
  streamText: "Hello world",
  urlIncludes: "api.groq.com/openai/v1",
});

describe("groq rate-limit header dialect", () => {
  it("parses duration-style reset values", () => {
    const snap = groqAdapter.parseRateLimitHeaders(
      new Headers(fixture.rateLimitHeaders),
    )!;
    expect(snap.limitRequests).toBe(14_400);
    expect(snap.remainingRequests).toBe(14_370);
    expect(snap.limitTokens).toBe(6000);
    expect(snap.remainingTokens).toBe(5460);
    expect(snap.resetRequestsMs).toBe(179_560); // "2m59.56s"
    expect(snap.resetTokensMs).toBe(7660); // "7.66s"
  });
});
