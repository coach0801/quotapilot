/**
 * Shared contract suite for the OpenAI-compatible adapters
 * (Groq, Mistral, OpenRouter, GitHub Models). Fixture-driven — runs on
 * every PR with fetch mocked; live smoke lives in live.test.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AdapterHttpError,
  type NormalizedChatRequest,
  type NormalizedChatResponse,
  type NormalizedChunk,
  type ProviderAdapter,
} from "@/core/types";
import { collect, jsonResponse, lastFetchCall, mockFetch, sseResponse } from "./helpers";

export interface CompatFixture {
  chat: Record<string, unknown> & { id: string; model: string };
  stream: unknown[];
  rateLimitHeaders: Record<string, string>;
}

export interface CompatExpectations {
  content: string;
  streamText: string;
  urlIncludes: string;
  authHeader?: [name: string, valueIncludes: string];
}

export function req(
  model: string,
  stream: boolean,
): NormalizedChatRequest {
  return {
    model,
    messages: [
      { role: "system", content: "You are terse." },
      { role: "user", content: "Say hello" },
    ],
    temperature: 0.2,
    maxTokens: 64,
    stream,
  };
}

export function runOpenAiCompatContract(
  adapter: ProviderAdapter,
  fixture: CompatFixture,
  expected: CompatExpectations,
) {
  describe(`${adapter.id} adapter contract`, () => {
    afterEach(() => vi.restoreAllMocks());

    it("normalizes a non-streaming completion", async () => {
      const spy = mockFetch(
        jsonResponse(fixture.chat, { headers: fixture.rateLimitHeaders }),
      );
      const res = (await adapter.chat(
        req(fixture.chat.model, false),
        "test-key",
        new AbortController().signal,
      )) as NormalizedChatResponse;

      expect(res.id).toBe(fixture.chat.id);
      expect(res.model).toBe(fixture.chat.model);
      expect(res.content).toBe(expected.content);
      expect(res.finishReason).toBe("stop");
      expect(res.usage?.promptTokens).toBeGreaterThan(0);
      expect(res.rateLimit).not.toBeUndefined();

      const call = lastFetchCall(spy);
      expect(call.url).toContain(expected.urlIncludes);
      expect(call.url).toContain("/chat/completions");
      expect(call.body.model).toBe(fixture.chat.model);
      expect(call.body.stream).toBe(false);
      expect(call.body.temperature).toBe(0.2);
      expect(call.body.max_tokens).toBe(64);
      const [hName, hVal] = expected.authHeader ?? ["Authorization", "Bearer test-key"];
      expect(
        (call.init.headers as Record<string, string>)[hName],
      ).toContain(hVal);
    });

    it("normalizes a streaming completion (SSE → chunks)", async () => {
      mockFetch(sseResponse(fixture.stream, { headers: fixture.rateLimitHeaders }));
      const stream = (await adapter.chat(
        req(fixture.chat.model, true),
        "test-key",
        new AbortController().signal,
      )) as ReadableStream<NormalizedChunk>;

      const chunks = await collect(stream);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.map((c) => c.delta).join("")).toBe(expected.streamText);
      expect(chunks[chunks.length - 1].finishReason).toBe("stop");
      // rate-limit snapshot rides on the first chunk
      expect(chunks[0].rateLimit).not.toBeUndefined();
    });

    it("throws a classified AdapterHttpError on upstream failure", async () => {
      mockFetch(
        jsonResponse(
          { error: { message: "rate limited" } },
          { status: 429, headers: { "retry-after": "30" } },
        ),
      );
      const promise = adapter.chat(
        req(fixture.chat.model, false),
        "test-key",
        new AbortController().signal,
      );
      await expect(promise).rejects.toBeInstanceOf(AdapterHttpError);
      try {
        mockFetch(
          jsonResponse({ error: "nope" }, { status: 429, headers: { "retry-after": "30" } }),
        );
        await adapter.chat(req(fixture.chat.model, false), "k", new AbortController().signal);
      } catch (e) {
        const httpError = e as AdapterHttpError;
        expect(httpError.status).toBe(429);
        expect(httpError.retryAfterMs).toBe(30_000);
        expect(adapter.classifyError(e)).toBe("rate_limited");
      }
    });

    it("implements the full error taxonomy", () => {
      const at = (status: number) => new AdapterHttpError(adapter.id, status, "");
      expect(adapter.classifyError(at(429))).toBe("rate_limited");
      expect(adapter.classifyError(at(401))).toBe("auth");
      expect(adapter.classifyError(at(403))).toBe("auth");
      expect(adapter.classifyError(at(500))).toBe("server");
      expect(adapter.classifyError(at(503))).toBe("server");
      expect(adapter.classifyError(at(400))).toBe("client");
      expect(adapter.classifyError(new TypeError("fetch failed"))).toBe("server");
    });

    it("parses this provider's rate-limit headers", () => {
      const snapshot = adapter.parseRateLimitHeaders(
        new Headers(fixture.rateLimitHeaders),
      );
      expect(snapshot).not.toBeNull();
    });

    it("exposes a model catalog with classes", () => {
      const models = adapter.models();
      expect(models.length).toBeGreaterThan(0);
      for (const m of models) {
        expect(["fast", "strong", "reasoning"]).toContain(m.modelClass);
      }
    });
  });
}
