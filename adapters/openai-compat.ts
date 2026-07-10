/**
 * Factory for OpenAI-compatible providers (Groq, Mistral, OpenRouter,
 * GitHub Models all speak the same chat-completions dialect).
 */

import type {
  FinishReason,
  ModelInfo,
  NormalizedChatRequest,
  NormalizedChatResponse,
  NormalizedChunk,
  NormalizedUsage,
  ProviderAdapter,
  ProviderId,
  RateLimitSnapshot,
} from "@/core/types";
import {
  classifyError,
  mapSseStream,
  parseCommonRateLimitHeaders,
  throwHttpError,
} from "./http";

export interface OpenAiCompatOptions {
  id: ProviderId;
  baseUrl: string;
  models: () => ModelInfo[];
  /** Build auth (and any provider-specific) headers for a request. */
  headers?: (key: string) => Record<string, string>;
  /** Override rate-limit header parsing (defaults to the common parser). */
  parseRateLimitHeaders?: (h: Headers) => RateLimitSnapshot | null;
}

export function mapFinishReason(
  reason: string | null | undefined,
): FinishReason | null {
  if (reason == null) return null;
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  return "other";
}

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

function mapUsage(u: WireUsage | null | undefined): NormalizedUsage | undefined {
  if (!u) return undefined;
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
  };
}

interface WireChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: WireUsage | null;
  /** Groq puts final usage under `x_groq`. */
  x_groq?: { usage?: WireUsage };
}

interface WireResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: WireUsage | null;
}

export function createOpenAiCompatAdapter(
  opts: OpenAiCompatOptions,
): ProviderAdapter {
  const buildHeaders =
    opts.headers ??
    ((key: string) => ({ Authorization: `Bearer ${key}` }));
  const parseHeaders =
    opts.parseRateLimitHeaders ?? parseCommonRateLimitHeaders;

  return {
    id: opts.id,
    models: opts.models,
    parseRateLimitHeaders: (h) => parseHeaders(h),
    classifyError,

    async chat(
      req: NormalizedChatRequest,
      key: string,
      signal: AbortSignal,
    ): Promise<NormalizedChatResponse | ReadableStream<NormalizedChunk>> {
      const res = await fetch(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          ...buildHeaders(key),
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          ...(req.temperature !== undefined && { temperature: req.temperature }),
          ...(req.maxTokens !== undefined && { max_tokens: req.maxTokens }),
          ...(req.stop !== undefined && { stop: req.stop }),
          stream: req.stream,
        }),
      });

      if (!res.ok) await throwHttpError(opts.id, res);
      const rateLimit = parseHeaders(res.headers) ?? undefined;

      if (!req.stream) {
        const json = (await res.json()) as WireResponse;
        const choice = json.choices?.[0];
        return {
          id: json.id ?? `${opts.id}-${Date.now().toString(36)}`,
          model: json.model ?? req.model,
          content: choice?.message?.content ?? "",
          finishReason: mapFinishReason(choice?.finish_reason) ?? "stop",
          usage: mapUsage(json.usage),
          rateLimit,
        };
      }

      if (!res.body) await throwHttpError(opts.id, res);
      let first = true;
      return mapSseStream<NormalizedChunk>(res.body!, (payload) => {
        let wire: WireChunk;
        try {
          wire = JSON.parse(payload) as WireChunk;
        } catch {
          return null; // skip malformed keep-alive/comment payloads
        }
        const choice = wire.choices?.[0];
        const chunk: NormalizedChunk = {
          id: wire.id ?? `${opts.id}-stream`,
          model: wire.model ?? req.model,
          delta: choice?.delta?.content ?? "",
          finishReason: mapFinishReason(choice?.finish_reason),
          usage: mapUsage(wire.usage ?? wire.x_groq?.usage),
        };
        if (first) {
          chunk.rateLimit = rateLimit;
          first = false;
        }
        return chunk;
      });
    },
  };
}
