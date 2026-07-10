/**
 * Google Gemini (AI Studio) adapter — native generateContent API,
 * mapped to/from the normalized chat protocol.
 *
 * Differences from the OpenAI dialect:
 *   - system messages go in `systemInstruction`, not the message list
 *   - roles are user/model, not user/assistant
 *   - streaming uses `:streamGenerateContent?alt=sse` (no [DONE] sentinel)
 *   - no rate-limit response headers on the free tier → returns null
 */

import { PROVIDERS } from "@/config/providers";
import type {
  FinishReason,
  NormalizedChatRequest,
  NormalizedChatResponse,
  NormalizedChunk,
  NormalizedUsage,
  ProviderAdapter,
} from "@/core/types";
import { classifyError, mapSseStream, throwHttpError } from "./http";

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
}

interface GeminiResponse {
  responseId?: string;
  modelVersion?: string;
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: GeminiUsageMetadata;
}

function mapFinish(reason: string | undefined): FinishReason | null {
  if (reason === undefined) return null;
  if (reason === "STOP") return "stop";
  if (reason === "MAX_TOKENS") return "length";
  return "other";
}

function mapUsage(u: GeminiUsageMetadata | undefined): NormalizedUsage | undefined {
  if (!u) return undefined;
  return {
    promptTokens: u.promptTokenCount ?? 0,
    completionTokens: u.candidatesTokenCount ?? 0,
  };
}

function candidateText(res: GeminiResponse): string {
  return (
    res.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("") ?? ""
  );
}

function toGeminiBody(req: NormalizedChatRequest) {
  const system = req.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  return {
    ...(system.length > 0 && {
      systemInstruction: { parts: [{ text: system }] },
    }),
    contents: req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
    generationConfig: {
      ...(req.temperature !== undefined && { temperature: req.temperature }),
      ...(req.maxTokens !== undefined && { maxOutputTokens: req.maxTokens }),
      ...(req.stop !== undefined && { stopSequences: req.stop }),
    },
  };
}

export const geminiAdapter: ProviderAdapter = {
  id: "gemini",
  models: () => PROVIDERS.gemini.models,
  // AI Studio free tier does not expose limits in response headers.
  parseRateLimitHeaders: () => null,
  classifyError,

  async chat(
    req: NormalizedChatRequest,
    key: string,
    signal: AbortSignal,
  ): Promise<NormalizedChatResponse | ReadableStream<NormalizedChunk>> {
    const method = req.stream
      ? "streamGenerateContent?alt=sse"
      : "generateContent";
    const res = await fetch(
      `${PROVIDERS.gemini.baseUrl}/models/${req.model}:${method}`,
      {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key,
        },
        body: JSON.stringify(toGeminiBody(req)),
      },
    );

    if (!res.ok) await throwHttpError("gemini", res);

    if (!req.stream) {
      const json = (await res.json()) as GeminiResponse;
      return {
        id: json.responseId ?? `gemini-${Date.now().toString(36)}`,
        model: json.modelVersion ?? req.model,
        content: candidateText(json),
        finishReason: mapFinish(json.candidates?.[0]?.finishReason) ?? "stop",
        usage: mapUsage(json.usageMetadata),
      };
    }

    if (!res.body) await throwHttpError("gemini", res);
    return mapSseStream<NormalizedChunk>(res.body!, (payload) => {
      let wire: GeminiResponse;
      try {
        wire = JSON.parse(payload) as GeminiResponse;
      } catch {
        return null;
      }
      return {
        id: wire.responseId ?? "gemini-stream",
        model: wire.modelVersion ?? req.model,
        delta: candidateText(wire),
        finishReason: mapFinish(wire.candidates?.[0]?.finishReason),
        usage: mapUsage(wire.usageMetadata),
      };
    });
  },
};
