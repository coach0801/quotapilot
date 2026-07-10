/**
 * OpenAI-format request/response mapping.
 *
 * Zod-validates the external boundary (OpenAI chat-completions subset) and
 * converts between OpenAI wire format and the internal Normalized* types.
 * Pure module — no I/O.
 */

import { z } from "zod";

import type {
  FinishReason,
  NormalizedChatRequest,
  NormalizedChatResponse,
  NormalizedChunk,
} from "./types";

// ---------------------------------------------------------------------------
// Request validation (OpenAI subset: model, messages, temperature, max_tokens,
// stream, stop — spec §6)
// ---------------------------------------------------------------------------

const contentPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.union([z.string(), z.array(contentPartSchema)]),
});

export const chatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
});

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;

/** BYOK header payload: {"groq": "gsk_...", "gemini": "AI..."} */
export const byokKeysSchema = z.record(z.string(), z.string().min(1));

export function toNormalizedRequest(
  req: ChatCompletionRequest,
): NormalizedChatRequest {
  return {
    model: req.model,
    messages: req.messages.map((m) => ({
      role: m.role,
      content:
        typeof m.content === "string"
          ? m.content
          : m.content.map((p) => p.text).join(""),
    })),
    temperature: req.temperature,
    maxTokens: req.max_tokens,
    stream: req.stream ?? false,
    stop:
      req.stop === undefined
        ? undefined
        : Array.isArray(req.stop)
          ? req.stop
          : [req.stop],
  };
}

// ---------------------------------------------------------------------------
// Response mapping (Normalized → OpenAI wire format)
// ---------------------------------------------------------------------------

export function toOpenAiFinishReason(reason: FinishReason | null | undefined) {
  if (reason === "length") return "length" as const;
  if (reason === "stop") return "stop" as const;
  return reason == null ? null : ("stop" as const);
}

export function toOpenAiResponse(
  res: NormalizedChatResponse,
  createdAtMs: number = Date.now(),
) {
  return {
    id: res.id,
    object: "chat.completion" as const,
    created: Math.floor(createdAtMs / 1000),
    model: res.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant" as const, content: res.content },
        finish_reason: toOpenAiFinishReason(res.finishReason) ?? "stop",
      },
    ],
    usage: res.usage
      ? {
          prompt_tokens: res.usage.promptTokens,
          completion_tokens: res.usage.completionTokens,
          total_tokens: res.usage.promptTokens + res.usage.completionTokens,
        }
      : undefined,
  };
}

export function toOpenAiChunk(
  chunk: NormalizedChunk,
  createdAtMs: number = Date.now(),
) {
  return {
    id: chunk.id,
    object: "chat.completion.chunk" as const,
    created: Math.floor(createdAtMs / 1000),
    model: chunk.model,
    choices: [
      {
        index: 0,
        delta: chunk.delta.length > 0 ? { content: chunk.delta } : {},
        finish_reason: toOpenAiFinishReason(chunk.finishReason),
      },
    ],
    usage: chunk.usage
      ? {
          prompt_tokens: chunk.usage.promptTokens,
          completion_tokens: chunk.usage.completionTokens,
          total_tokens:
            chunk.usage.promptTokens + chunk.usage.completionTokens,
        }
      : undefined,
  };
}

/**
 * Encode a stream of normalized chunks as OpenAI-style SSE
 * (`data: {json}\n\n` … `data: [DONE]\n\n`).
 */
export function sseEncodeStream(
  source: ReadableStream<NormalizedChunk>,
  onChunk?: (chunk: NormalizedChunk) => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      onChunk?.(value);
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(toOpenAiChunk(value))}\n\n`),
      );
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

// ---------------------------------------------------------------------------
// OpenAI-shaped errors
// ---------------------------------------------------------------------------

export function openAiError(
  message: string,
  type:
    | "invalid_request_error"
    | "authentication_error"
    | "rate_limit_error"
    | "api_error",
  code?: string,
) {
  return { error: { message, type, code: code ?? null, param: null } };
}

/** Rough token estimate (~4 chars/token) for providers that omit usage. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
