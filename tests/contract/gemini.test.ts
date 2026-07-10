import { afterEach, describe, expect, it, vi } from "vitest";

import { geminiAdapter } from "@/adapters/gemini";
import {
  AdapterHttpError,
  type NormalizedChatResponse,
  type NormalizedChunk,
} from "@/core/types";
import fixture from "./fixtures/gemini.json";
import { collect, jsonResponse, lastFetchCall, mockFetch } from "./helpers";
import { req } from "./openai-compat.shared";

function geminiSse(payloads: unknown[]): Response {
  // Gemini's alt=sse stream has no [DONE] sentinel
  const body = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("gemini adapter contract", () => {
  afterEach(() => vi.restoreAllMocks());

  it("normalizes a non-streaming completion and maps the request format", async () => {
    const spy = mockFetch(jsonResponse(fixture.chat));
    const res = (await geminiAdapter.chat(
      req("gemini-2.5-flash", false),
      "test-key",
      new AbortController().signal,
    )) as NormalizedChatResponse;

    expect(res.id).toBe("resp-gemini-fixture");
    expect(res.model).toBe("gemini-2.5-flash");
    expect(res.content).toBe("Hello from Gemini!");
    expect(res.finishReason).toBe("stop");
    expect(res.usage).toEqual({ promptTokens: 8, completionTokens: 6 });

    const call = lastFetchCall(spy);
    expect(call.url).toContain("/models/gemini-2.5-flash:generateContent");
    expect(
      (call.init.headers as Record<string, string>)["x-goog-api-key"],
    ).toBe("test-key");
    // system message extracted, remaining messages role-mapped user/model
    expect(call.body.systemInstruction).toEqual({
      parts: [{ text: "You are terse." }],
    });
    expect(call.body.contents).toEqual([
      { role: "user", parts: [{ text: "Say hello" }] },
    ]);
    expect(call.body.generationConfig).toMatchObject({
      temperature: 0.2,
      maxOutputTokens: 64,
    });
  });

  it("maps assistant history to the model role", async () => {
    const spy = mockFetch(jsonResponse(fixture.chat));
    await geminiAdapter.chat(
      {
        model: "gemini-2.5-flash",
        stream: false,
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "again" },
        ],
      },
      "k",
      new AbortController().signal,
    );
    const call = lastFetchCall(spy);
    expect((call.body.contents as Array<{ role: string }>).map((c) => c.role)).toEqual([
      "user",
      "model",
      "user",
    ]);
  });

  it("normalizes a streaming completion via alt=sse", async () => {
    const spy = mockFetch(geminiSse(fixture.stream));
    const stream = (await geminiAdapter.chat(
      req("gemini-2.5-flash", true),
      "test-key",
      new AbortController().signal,
    )) as ReadableStream<NormalizedChunk>;

    const chunks = await collect(stream);
    expect(lastFetchCall(spy).url).toContain(
      ":streamGenerateContent?alt=sse",
    );
    expect(chunks.map((c) => c.delta).join("")).toBe("Hello!");
    expect(chunks[chunks.length - 1].finishReason).toBe("stop");
    expect(chunks[chunks.length - 1].usage).toEqual({
      promptTokens: 8,
      completionTokens: 2,
    });
  });

  it("maps MAX_TOKENS to length", async () => {
    const truncated = structuredClone(fixture.chat);
    truncated.candidates[0].finishReason = "MAX_TOKENS";
    mockFetch(jsonResponse(truncated));
    const res = (await geminiAdapter.chat(
      req("gemini-2.5-flash", false),
      "k",
      new AbortController().signal,
    )) as NormalizedChatResponse;
    expect(res.finishReason).toBe("length");
  });

  it("classifies errors and reports no header-based limits", async () => {
    mockFetch(jsonResponse({ error: { message: "quota" } }, { status: 429 }));
    await expect(
      geminiAdapter.chat(req("gemini-2.5-flash", false), "k", new AbortController().signal),
    ).rejects.toBeInstanceOf(AdapterHttpError);

    const at = (s: number) => new AdapterHttpError("gemini", s, "");
    expect(geminiAdapter.classifyError(at(429))).toBe("rate_limited");
    expect(geminiAdapter.classifyError(at(403))).toBe("auth");
    expect(geminiAdapter.classifyError(at(500))).toBe("server");
    expect(geminiAdapter.parseRateLimitHeaders(new Headers())).toBeNull();
  });
});
