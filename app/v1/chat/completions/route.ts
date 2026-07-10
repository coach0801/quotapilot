/**
 * POST /v1/chat/completions — the OpenAI-compatible gateway (spec §6, §8.18).
 *
 * Zod-validate → resolve key set (BYOK header, or demo pool for playground
 * traffic with a per-IP limit) → router → failover across adapters →
 * normalized response/stream with x-qp-* headers.
 *
 * Privacy: prompts, keys and IPs are never logged or stored; Redis sees
 * only SHA-256 hashes, Neon only routing metadata.
 */

import { after, NextResponse } from "next/server";

import { ADAPTERS } from "@/adapters";
import { PROVIDERS, RELIABILITY_ORDER, demoKeySet } from "@/config/providers";
import { runFailover } from "@/core/failover";
import {
  chatCompletionRequestSchema,
  estimateTokens,
  openAiError,
  sseEncodeStream,
  toNormalizedRequest,
  toOpenAiResponse,
} from "@/core/normalize";
import {
  bumpUsage,
  consumeDemoLimit,
  markExhausted,
  readHealth,
  readQuota,
  recordHealth,
  sha256Hex,
  syncDailyFromSnapshot,
} from "@/core/quota";
import { parseModelSelector, route } from "@/core/router";
import {
  AdapterHttpError,
  type NormalizedChatResponse,
  type NormalizedChunk,
  type NormalizedUsage,
  type ProviderId,
} from "@/core/types";
import { getDb } from "@/db/client";
import { logRequest } from "@/db/queries";
import {
  clientIp,
  hashKeySet,
  isPlaygroundOrigin,
  parseByokHeader,
  type KeySet,
} from "@/lib/keys";
import { getRedis } from "@/lib/redis";

export const runtime = "edge";

/** Per-upstream-attempt budget, inside Vercel's 60s function limit. */
const UPSTREAM_TIMEOUT_MS = 50_000;

function errorResponse(
  status: number,
  message: string,
  type: Parameters<typeof openAiError>[1],
  headers?: Record<string, string>,
) {
  return NextResponse.json(openAiError(message, type), { status, headers });
}

export async function POST(req: Request): Promise<Response> {
  const redis = getRedis();

  // 1. Validate body (OpenAI schema subset) --------------------------------
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, "Request body must be valid JSON.", "invalid_request_error");
  }
  const parsed = chatCompletionRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return errorResponse(
      400,
      `Invalid request: ${issue.path.join(".")} — ${issue.message}`,
      "invalid_request_error",
    );
  }
  const normalized = toNormalizedRequest(parsed.data);

  // 2. Resolve key set: BYOK ∪ demo pool ------------------------------------
  const byok = parseByokHeader(req.headers.get("x-qp-keys"));
  if (byok === null) {
    return errorResponse(
      400,
      'Malformed x-qp-keys header. Expected JSON like {"groq":"gsk_...","gemini":"..."}.',
      "invalid_request_error",
    );
  }

  let keys: KeySet = byok;
  let demoRemaining: number | undefined;
  if (Object.keys(keys).length === 0) {
    if (!isPlaygroundOrigin(req.headers, req.url)) {
      return errorResponse(
        401,
        'No provider keys supplied. Pass your own free keys in the x-qp-keys header, e.g. x-qp-keys: {"groq":"gsk_..."} — QuotaPilot never stores them. See /docs.',
        "authentication_error",
      );
    }
    keys = demoKeySet();
    if (Object.keys(keys).length === 0) {
      return errorResponse(
        503,
        "Demo pool is not configured on this deployment. Bring your own keys via x-qp-keys.",
        "api_error",
      );
    }
    const ipHash = await sha256Hex(clientIp(req.headers));
    const demo = await consumeDemoLimit(redis, ipHash);
    demoRemaining = demo.remaining;
    if (!demo.allowed) {
      return errorResponse(
        429,
        `Playground demo limit reached (${demo.limit}/day per IP). Paste your own free provider keys for unlimited use — see /docs.`,
        "rate_limit_error",
        { "retry-after": "3600", "x-qp-demo-remaining": "0" },
      );
    }
  }

  const providers = Object.keys(keys) as ProviderId[];
  const keyHashes = await hashKeySet(keys);

  // 3. Route ---------------------------------------------------------------
  const [quota, health] = await Promise.all([
    readQuota(redis, keyHashes),
    readHealth(redis, providers),
  ]);
  const routed = route({
    model: normalized.model,
    quota,
    health,
    config: PROVIDERS,
    availableProviders: providers,
    reliabilityOrder: RELIABILITY_ORDER,
  });

  if (!routed.ok) {
    if (routed.reason === "unknown_model") {
      return errorResponse(
        404,
        `Unknown model "${normalized.model}". Use a concrete id (e.g. "groq/llama-3.3-70b-versatile"), a bare catalog id, or a class ("auto:fast" | "auto:strong" | "auto:reasoning").`,
        "invalid_request_error",
      );
    }
    if (routed.reason === "unsupported") {
      return errorResponse(
        400,
        `No provider in your key set serves "${normalized.model}". Add a key for a provider that has it, or use an auto:<class> model.`,
        "invalid_request_error",
      );
    }
    const retryAfterS = Math.max(1, Math.ceil(routed.retryAfterMs / 1000));
    return errorResponse(
      429,
      `All providers in your key set are out of quota. Retry in ~${retryAfterS}s.`,
      "rate_limit_error",
      { "retry-after": String(retryAfterS) },
    );
  }

  // 4. Failover across the ranked list --------------------------------------
  const selector = parseModelSelector(normalized.model, PROVIDERS);
  const modelClass = selector.kind === "class" ? selector.modelClass : null;
  const startedAt = Date.now();
  let upstreamLatencyMs = 0;

  const result = await runFailover(routed.candidates, {
    async execute(candidate) {
      const t0 = Date.now();
      try {
        const value = await ADAPTERS[candidate.provider].chat(
          { ...normalized, model: candidate.model },
          keys[candidate.provider]!,
          AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        );
        upstreamLatencyMs = Date.now() - t0;
        after(() => recordHealth(redis, candidate.provider, true, Date.now() - t0));
        return value;
      } catch (error) {
        after(() => recordHealth(redis, candidate.provider, false, Date.now() - t0));
        throw error;
      }
    },
    classify: (provider, error) => ADAPTERS[provider].classifyError(error),
    async onExhausted(candidate, error) {
      const forMs =
        error instanceof AdapterHttpError && error.retryAfterMs !== undefined
          ? error.retryAfterMs
          : 60_000;
      await markExhausted(redis, keyHashes[candidate.provider]!, candidate.provider, forMs);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });

  if (!result.ok) {
    after(() =>
      logRequest(getDb(), {
        provider: result.provider ?? "none",
        model: normalized.model,
        modelClass,
        latencyMs: Date.now() - startedAt,
        outcome: result.reason,
        fallbackDepth: result.fallbackDepth,
      }).catch(() => {}),
    );
    const upstream =
      result.error instanceof AdapterHttpError ? result.error : undefined;
    if (result.reason === "auth") {
      return errorResponse(
        401,
        `Provider ${result.provider} rejected your key (HTTP ${upstream?.status ?? 401}). Check the corresponding x-qp-keys entry.`,
        "authentication_error",
      );
    }
    if (result.reason === "client") {
      return errorResponse(
        400,
        `Provider ${result.provider} rejected the request: ${upstream?.body.slice(0, 200) ?? "bad request"}`,
        "invalid_request_error",
      );
    }
    // exhausted: every candidate failed with a retryable error
    if (upstream?.status === 429) {
      return errorResponse(
        429,
        "All providers are currently rate-limited. Retry shortly.",
        "rate_limit_error",
        { "retry-after": "60" },
      );
    }
    return errorResponse(
      502,
      "All upstream providers failed. This is transient — retry shortly.",
      "api_error",
    );
  }

  // 5. Success: headers, accounting, response --------------------------------
  const winner = result.provider;
  const winnerHash = keyHashes[winner]!;

  const remaining: Record<string, { rpd: number }> = {};
  for (const p of providers) {
    const used = (quota[p]?.rpdUsed ?? 0) + (p === winner ? 1 : 0);
    remaining[p] = { rpd: Math.max(0, PROVIDERS[p].limits.rpd - used) };
  }
  const headers: Record<string, string> = {
    "x-qp-provider": winner,
    "x-qp-model": result.model,
    "x-qp-fallback-depth": String(result.fallbackDepth),
    "x-qp-remaining": JSON.stringify(remaining),
  };
  if (demoRemaining !== undefined) {
    headers["x-qp-demo-remaining"] = String(demoRemaining);
  }

  const promptChars = normalized.messages.reduce(
    (n, m) => n + m.content.length,
    0,
  );

  const account = (usage: NormalizedUsage | undefined, completionText: string) => {
    const tokensIn = usage?.promptTokens ?? Math.max(1, Math.ceil(promptChars / 4));
    const tokensOut = usage?.completionTokens ?? estimateTokens(completionText);
    return Promise.allSettled([
      bumpUsage(redis, winnerHash, winner, tokensIn + tokensOut),
      logRequest(getDb(), {
        provider: winner,
        model: result.model,
        modelClass,
        latencyMs: upstreamLatencyMs,
        tokensIn,
        tokensOut,
        outcome: "ok",
        fallbackDepth: result.fallbackDepth,
      }),
    ]);
  };

  if (!(result.value instanceof ReadableStream)) {
    const response = result.value as NormalizedChatResponse;
    after(async () => {
      await account(response.usage, response.content);
      if (response.rateLimit) {
        await syncDailyFromSnapshot(redis, winnerHash, winner, response.rateLimit);
      }
    });
    return NextResponse.json(toOpenAiResponse(response), { headers });
  }

  // Streaming: pass chunks through as SSE; account once the stream ends.
  let streamedText = "";
  let streamedUsage: NormalizedUsage | undefined;
  let firstRateLimit: NormalizedChunk["rateLimit"];
  const body = sseEncodeStream(result.value, (chunk) => {
    streamedText += chunk.delta;
    if (chunk.usage) streamedUsage = chunk.usage;
    if (chunk.rateLimit && !firstRateLimit) firstRateLimit = chunk.rateLimit;
  });

  after(async () => {
    await account(streamedUsage, streamedText);
    if (firstRateLimit) {
      await syncDailyFromSnapshot(redis, winnerHash, winner, firstRateLimit);
    }
  });

  return new Response(body, {
    headers: {
      ...headers,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
