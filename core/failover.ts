/**
 * Failover state machine (spec §8 step 16).
 *
 * Try the router's ranked candidate list in order; per attempt apply the
 * error taxonomy:
 *   rate_limited (429) → mark provider exhausted, move to next provider
 *   server (5xx)       → retry same provider ×2 with 500ms/2s backoff,
 *                        then move to next provider
 *   client / auth      → stop immediately, surface to caller
 * Max fallback depth 3 (initial attempt + up to 3 re-routes).
 *
 * All effects (execution, classification, exhaustion marking, sleeping)
 * are injected, so every transition is unit-testable with zero real I/O.
 */

import type { ErrorClass, ProviderId } from "./types";
import type { RouteCandidate } from "./router";

export const MAX_FALLBACK_DEPTH = 3;
export const SERVER_RETRY_BACKOFF_MS: readonly number[] = [500, 2000];

export interface FailoverDeps<T> {
  /** Perform one upstream attempt. Throws on failure. */
  execute(candidate: RouteCandidate, fallbackDepth: number): Promise<T>;
  /** Map a thrown error to the retry taxonomy for that provider. */
  classify(provider: ProviderId, error: unknown): ErrorClass;
  /** Called when a provider returns rate_limited (mark exhausted in Redis). */
  onExhausted(
    candidate: RouteCandidate,
    error: unknown,
  ): void | Promise<void>;
  /** Injected for tests; production passes a real timer. */
  sleep(ms: number): Promise<void>;
}

export interface FailoverOptions {
  maxFallbackDepth?: number;
  serverRetryBackoffMs?: readonly number[];
}

export type FailoverResult<T> =
  | {
      ok: true;
      value: T;
      provider: ProviderId;
      model: string;
      fallbackDepth: number;
    }
  | {
      ok: false;
      /**
       * exhausted — every candidate failed with a retryable error
       * client/auth — the caller's request/key is bad; not retryable
       */
      reason: "exhausted" | "client" | "auth";
      error: unknown;
      /** Provider whose response ended the run (last tried). */
      provider?: ProviderId;
      fallbackDepth: number;
    };

export async function runFailover<T>(
  candidates: readonly RouteCandidate[],
  deps: FailoverDeps<T>,
  options: FailoverOptions = {},
): Promise<FailoverResult<T>> {
  const maxDepth = options.maxFallbackDepth ?? MAX_FALLBACK_DEPTH;
  const backoffs = options.serverRetryBackoffMs ?? SERVER_RETRY_BACKOFF_MS;

  let lastError: unknown = new Error("no providers available");
  let lastProvider: ProviderId | undefined;
  let depth = 0;

  for (let i = 0; i < candidates.length && depth <= maxDepth; i++, depth++) {
    const candidate = candidates[i];
    lastProvider = candidate.provider;

    // Up to 1 initial try + backoffs.length retries against this provider
    // (retries only for `server` errors).
    for (let attempt = 0; ; attempt++) {
      try {
        const value = await deps.execute(candidate, depth);
        return {
          ok: true,
          value,
          provider: candidate.provider,
          model: candidate.model,
          fallbackDepth: depth,
        };
      } catch (error) {
        lastError = error;
        const cls = deps.classify(candidate.provider, error);

        if (cls === "client" || cls === "auth") {
          // The caller's request or key is bad — no other provider will fix it.
          return {
            ok: false,
            reason: cls,
            error,
            provider: candidate.provider,
            fallbackDepth: depth,
          };
        }
        if (cls === "rate_limited") {
          await deps.onExhausted(candidate, error);
          break; // next provider
        }
        // server error: retry with backoff, then give up on this provider
        if (attempt < backoffs.length) {
          await deps.sleep(backoffs[attempt]);
          continue;
        }
        break; // next provider
      }
    }
  }

  return {
    ok: false,
    reason: "exhausted",
    error: lastError,
    provider: lastProvider,
    fallbackDepth: Math.max(0, depth - 1),
  };
}
