/**
 * Shared HTTP/SSE plumbing for provider adapters: error classification,
 * rate-limit header parsing, and server-sent-event stream decoding.
 */

import { AdapterHttpError } from "@/core/types";
import type { ErrorClass, ProviderId, RateLimitSnapshot } from "@/core/types";

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

export function classifyHttpStatus(status: number): ErrorClass {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "server";
  return "client";
}

/**
 * Default classifier shared by all adapters. Unknown/network/timeout errors
 * classify as `server` so the failover machine retries elsewhere.
 */
export function classifyError(e: unknown): ErrorClass {
  if (e instanceof AdapterHttpError) return classifyHttpStatus(e.status);
  return "server";
}

// ---------------------------------------------------------------------------
// Rate-limit header parsing
// ---------------------------------------------------------------------------

function num(h: Headers, ...names: string[]): number | undefined {
  for (const n of names) {
    const raw = h.get(n);
    if (raw !== null && raw !== "") {
      const v = Number(raw);
      if (Number.isFinite(v)) return v;
    }
  }
  return undefined;
}

/**
 * Parse a reset value into "ms from now". Accepts:
 *   "7.66s", "2m59.56s", "1h2m" — Groq-style durations
 *   "30" — relative seconds
 *   epoch seconds / epoch milliseconds — OpenRouter-style absolute stamps
 */
export function parseResetMs(
  raw: string | null,
  now: number = Date.now(),
): number | undefined {
  if (raw === null || raw === "") return undefined;
  if (/[hms]/i.test(raw)) {
    let ms = 0;
    const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/gi;
    let match: RegExpExecArray | null;
    let matched = false;
    while ((match = re.exec(raw)) !== null) {
      matched = true;
      const v = Number(match[1]);
      const unit = match[2].toLowerCase();
      ms +=
        unit === "h" ? v * 3_600_000
        : unit === "m" ? v * 60_000
        : unit === "ms" ? v
        : v * 1000;
    }
    return matched ? Math.round(ms) : undefined;
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) return undefined;
  if (v > 1e12) return Math.max(0, Math.round(v - now)); // epoch ms
  if (v > 1e9) return Math.max(0, Math.round(v * 1000 - now)); // epoch s
  return Math.round(v * 1000); // relative seconds
}

/**
 * Generic parser covering the header dialects of Groq, Mistral, OpenRouter
 * and GitHub Models. Returns null when no rate-limit info is present.
 */
export function parseCommonRateLimitHeaders(
  h: Headers,
  now: number = Date.now(),
): RateLimitSnapshot | null {
  const snapshot: RateLimitSnapshot = {
    limitRequests: num(h, "x-ratelimit-limit-requests", "x-ratelimit-limit"),
    remainingRequests: num(
      h,
      "x-ratelimit-remaining-requests",
      "x-ratelimit-remaining",
    ),
    limitTokens: num(h, "x-ratelimit-limit-tokens", "x-ratelimitbysize-limit"),
    remainingTokens: num(
      h,
      "x-ratelimit-remaining-tokens",
      "x-ratelimitbysize-remaining",
    ),
    resetRequestsMs: parseResetMs(
      h.get("x-ratelimit-reset-requests") ?? h.get("x-ratelimit-reset"),
      now,
    ),
    resetTokensMs: parseResetMs(h.get("x-ratelimit-reset-tokens"), now),
  };
  const hasAny = Object.values(snapshot).some((v) => v !== undefined);
  return hasAny ? snapshot : null;
}

export function retryAfterMs(h: Headers): number | undefined {
  return parseResetMs(h.get("retry-after"));
}

/** Read the error body and throw a classified AdapterHttpError. */
export async function throwHttpError(
  provider: ProviderId,
  res: Response,
): Promise<never> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* body unreadable — status alone is enough to classify */
  }
  throw new AdapterHttpError(provider, res.status, body, retryAfterMs(res.headers));
}

// ---------------------------------------------------------------------------
// SSE decoding
// ---------------------------------------------------------------------------

/**
 * Decode a `text/event-stream` body into the string payload of each
 * `data:` line. (The OpenAI-compatible providers and Gemini's `alt=sse`
 * endpoint all emit one JSON document per data line.)
 */
export function sseDataStream(
  body: ReadableStream<Uint8Array>,
): ReadableStream<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  const transform = new TransformStream<Uint8Array, string>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line.startsWith("data:")) {
          controller.enqueue(line.slice(5).trimStart());
        }
      }
    },
    flush(controller) {
      const line = buffer.replace(/\r$/, "");
      if (line.startsWith("data:")) controller.enqueue(line.slice(5).trimStart());
    },
  });

  return body.pipeThrough(transform);
}

/**
 * Map a stream of parsed SSE payloads through `mapPayload`, dropping
 * null results and ending the stream when `isDone` matches.
 */
export function mapSseStream<T>(
  body: ReadableStream<Uint8Array>,
  mapPayload: (payload: string) => T | null,
  isDone: (payload: string) => boolean = (p) => p === "[DONE]",
): ReadableStream<T> {
  const reader = sseDataStream(body).getReader();
  return new ReadableStream<T>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (isDone(value)) {
          await reader.cancel();
          controller.close();
          return;
        }
        const mapped = mapPayload(value);
        if (mapped !== null) {
          controller.enqueue(mapped);
          return;
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
