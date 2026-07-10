import { describe, expect, it } from "vitest";

import {
  chatCompletionRequestSchema,
  estimateTokens,
  openAiError,
  sseEncodeStream,
  toNormalizedRequest,
  toOpenAiChunk,
  toOpenAiResponse,
} from "@/core/normalize";
import type { NormalizedChunk } from "@/core/types";

const minimal = {
  model: "auto:fast",
  messages: [{ role: "user", content: "hi" }],
};

describe("chatCompletionRequestSchema", () => {
  it("accepts the OpenAI subset", () => {
    const parsed = chatCompletionRequestSchema.safeParse({
      ...minimal,
      temperature: 0.7,
      max_tokens: 100,
      stream: true,
      stop: ["\n"],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects empty messages, bad roles, and out-of-range temperature", () => {
    expect(chatCompletionRequestSchema.safeParse({ model: "x", messages: [] }).success).toBe(false);
    expect(
      chatCompletionRequestSchema.safeParse({
        model: "x",
        messages: [{ role: "tool", content: "hi" }],
      }).success,
    ).toBe(false);
    expect(
      chatCompletionRequestSchema.safeParse({ ...minimal, temperature: 3 }).success,
    ).toBe(false);
  });

  it("accepts array-of-parts content and flattens it in normalization", () => {
    const parsed = chatCompletionRequestSchema.parse({
      model: "auto:fast",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "part one " },
            { type: "text", text: "part two" },
          ],
        },
      ],
    });
    const normalized = toNormalizedRequest(parsed);
    expect(normalized.messages[0].content).toBe("part one part two");
  });
});

describe("toNormalizedRequest", () => {
  it("defaults stream=false and normalizes stop to an array", () => {
    const a = toNormalizedRequest(chatCompletionRequestSchema.parse(minimal));
    expect(a.stream).toBe(false);
    expect(a.stop).toBeUndefined();

    const b = toNormalizedRequest(
      chatCompletionRequestSchema.parse({ ...minimal, stop: "END" }),
    );
    expect(b.stop).toEqual(["END"]);
  });
});

describe("toOpenAiResponse / toOpenAiChunk", () => {
  it("produces the OpenAI chat.completion shape", () => {
    const res = toOpenAiResponse(
      {
        id: "resp-1",
        model: "llama-3.3-70b-versatile",
        content: "hello",
        finishReason: "stop",
        usage: { promptTokens: 3, completionTokens: 5 },
      },
      1_752_000_000_000,
    );
    expect(res).toEqual({
      id: "resp-1",
      object: "chat.completion",
      created: 1_752_000_000,
      model: "llama-3.3-70b-versatile",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    });
  });

  it("maps finish reasons and omits empty deltas", () => {
    const chunk = toOpenAiChunk({
      id: "c1",
      model: "m",
      delta: "",
      finishReason: "length",
    });
    expect(chunk.choices[0]).toEqual({ index: 0, delta: {}, finish_reason: "length" });

    const mid = toOpenAiChunk({ id: "c1", model: "m", delta: "hi", finishReason: null });
    expect(mid.choices[0]).toEqual({
      index: 0,
      delta: { content: "hi" },
      finish_reason: null,
    });
  });
});

describe("sseEncodeStream", () => {
  it("emits data: lines and a [DONE] sentinel, and reports chunks", async () => {
    const chunks: NormalizedChunk[] = [
      { id: "s", model: "m", delta: "Hel", finishReason: null },
      { id: "s", model: "m", delta: "lo", finishReason: "stop" },
    ];
    const source = new ReadableStream<NormalizedChunk>({
      start(c) {
        chunks.forEach((ch) => c.enqueue(ch));
        c.close();
      },
    });
    const seen: string[] = [];
    const encoded = sseEncodeStream(source, (c) => seen.push(c.delta));

    const reader = encoded.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }

    const lines = text.split("\n\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0].slice(6)).choices[0].delta.content).toBe("Hel");
    expect(JSON.parse(lines[1].slice(6)).choices[0].finish_reason).toBe("stop");
    expect(lines[2]).toBe("data: [DONE]");
    expect(seen).toEqual(["Hel", "lo"]);
  });
});

describe("helpers", () => {
  it("openAiError matches the OpenAI error envelope", () => {
    expect(openAiError("nope", "rate_limit_error", "quota")).toEqual({
      error: { message: "nope", type: "rate_limit_error", code: "quota", param: null },
    });
  });

  it("estimateTokens is ~chars/4 with a floor of 1", () => {
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
  });
});
