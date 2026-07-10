/**
 * Redis counter read/write: sliding-window RPM, daily RPD, TPM, provider
 * health EWMA, exhaustion marks, and the playground per-IP demo limiter.
 *
 * The Redis client is injected via the minimal `RedisLike` interface
 * (satisfied by `@upstash/redis`) so everything here is unit-testable
 * against an in-memory fake.
 *
 * Key layout (spec §5):
 *   qp:quota:{keyHash}:{provider}:rpm   — sliding-window counter, 60s TTL
 *   qp:quota:{keyHash}:{provider}:rpd   — daily counter, midnight-UTC TTL
 *   qp:quota:{keyHash}:{provider}:tpm   — token counter, 60s TTL
 *   qp:exhausted:{keyHash}:{provider}   — set by failover on upstream 429
 *   qp:health:{provider}                — rolling error-rate + latency EWMA
 *   qp:demo:{ipHash}:daily              — playground limiter (5/day)
 */

import type {
  HealthState,
  ProviderHealthState,
  ProviderId,
  ProviderQuotaState,
  QuotaState,
  RateLimitSnapshot,
} from "./types";

export interface RedisLike {
  incr(key: string): Promise<number>;
  incrby(key: string, increment: number): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  get(key: string): Promise<unknown>;
  set(
    key: string,
    value: string | number,
    opts?: { ex?: number; px?: number },
  ): Promise<unknown>;
  ttl(key: string): Promise<number>;
}

const RPM_WINDOW_S = 60;
const HEALTH_TTL_S = 6 * 60 * 60;
const HEALTH_ALPHA = 0.2;
export const DEMO_DAILY_LIMIT = 5;

// ---------------------------------------------------------------------------
// Time & hashing helpers
// ---------------------------------------------------------------------------

/** Seconds from `now` until the next midnight UTC (≥ 1). */
export function secondsToMidnightUtc(now: number = Date.now()): number {
  const d = new Date(now);
  const midnight = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((midnight - now) / 1000));
}

/** SHA-256 hex digest (Web Crypto — works on Edge, Node ≥ 20, browsers). */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const quotaKey = (
  keyHash: string,
  provider: ProviderId,
  kind: "rpm" | "rpd" | "tpm",
) => `qp:quota:${keyHash}:${provider}:${kind}`;
const exhaustedKey = (keyHash: string, provider: ProviderId) =>
  `qp:exhausted:${keyHash}:${provider}`;
const healthKey = (provider: ProviderId) => `qp:health:${provider}`;
const demoKey = (ipHash: string) => `qp:demo:${ipHash}:daily`;

async function incrWithTtl(
  redis: RedisLike,
  key: string,
  by: number,
  ttlSeconds: number,
): Promise<number> {
  const n = by === 1 ? await redis.incr(key) : await redis.incrby(key, by);
  // First writer of the window sets the TTL.
  if (n === by) await redis.expire(key, ttlSeconds);
  return n;
}

// ---------------------------------------------------------------------------
// Usage counters
// ---------------------------------------------------------------------------

/** Record one completed request (and its token cost) against a key+provider. */
export async function bumpUsage(
  redis: RedisLike,
  keyHash: string,
  provider: ProviderId,
  tokens: number,
  now: number = Date.now(),
): Promise<void> {
  await Promise.all([
    incrWithTtl(redis, quotaKey(keyHash, provider, "rpm"), 1, RPM_WINDOW_S),
    incrWithTtl(
      redis,
      quotaKey(keyHash, provider, "rpd"),
      1,
      secondsToMidnightUtc(now),
    ),
    tokens > 0
      ? incrWithTtl(
          redis,
          quotaKey(keyHash, provider, "tpm"),
          Math.round(tokens),
          RPM_WINDOW_S,
        )
      : Promise.resolve(0),
  ]);
}

function asCount(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

/** Read current usage + reset horizons for a set of providers. */
export async function readQuota(
  redis: RedisLike,
  keyHashes: Partial<Record<ProviderId, string>>,
  now: number = Date.now(),
): Promise<QuotaState> {
  const providers = Object.keys(keyHashes) as ProviderId[];
  const entries = await Promise.all(
    providers.map(async (provider): Promise<[ProviderId, ProviderQuotaState]> => {
      const keyHash = keyHashes[provider]!;
      const [rpm, rpd, tpm, rpmTtl, exhaustedTtl] = await Promise.all([
        redis.get(quotaKey(keyHash, provider, "rpm")),
        redis.get(quotaKey(keyHash, provider, "rpd")),
        redis.get(quotaKey(keyHash, provider, "tpm")),
        redis.ttl(quotaKey(keyHash, provider, "rpm")),
        redis.ttl(exhaustedKey(keyHash, provider)),
      ]);
      return [
        provider,
        {
          rpmUsed: asCount(rpm),
          rpdUsed: asCount(rpd),
          tpmUsed: asCount(tpm),
          rpmResetMs: rpmTtl > 0 ? rpmTtl * 1000 : RPM_WINDOW_S * 1000,
          rpdResetMs: secondsToMidnightUtc(now) * 1000,
          exhaustedForMs: exhaustedTtl > 0 ? exhaustedTtl * 1000 : undefined,
        },
      ];
    }),
  );
  return Object.fromEntries(entries) as QuotaState;
}

/**
 * Mark a provider exhausted for this key (upstream said 429). The router
 * skips exhausted providers until the mark expires.
 */
export async function markExhausted(
  redis: RedisLike,
  keyHash: string,
  provider: ProviderId,
  forMs: number = RPM_WINDOW_S * 1000,
): Promise<void> {
  await redis.set(exhaustedKey(keyHash, provider), 1, {
    px: Math.max(1000, Math.round(forMs)),
  });
}

/**
 * Reconcile our daily counter with authoritative remaining-request headers
 * (spec §3.1 design rule). Providers that report daily request budgets
 * (e.g. Groq) let us correct drift from restarts or out-of-band usage.
 */
export async function syncDailyFromSnapshot(
  redis: RedisLike,
  keyHash: string,
  provider: ProviderId,
  snapshot: RateLimitSnapshot,
  now: number = Date.now(),
): Promise<void> {
  if (
    snapshot.limitRequests === undefined ||
    snapshot.remainingRequests === undefined
  )
    return;
  const used = Math.max(0, snapshot.limitRequests - snapshot.remainingRequests);
  await redis.set(quotaKey(keyHash, provider, "rpd"), used, {
    ex: secondsToMidnightUtc(now),
  });
}

// ---------------------------------------------------------------------------
// Provider health (rolling error-rate + latency EWMA)
// ---------------------------------------------------------------------------

function parseHealth(raw: unknown): ProviderHealthState | undefined {
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (
      obj &&
      typeof obj === "object" &&
      typeof (obj as ProviderHealthState).errorRate === "number" &&
      typeof (obj as ProviderHealthState).latencyMs === "number"
    ) {
      return obj as ProviderHealthState;
    }
  } catch {
    /* corrupt value → treat as absent */
  }
  return undefined;
}

export async function recordHealth(
  redis: RedisLike,
  provider: ProviderId,
  ok: boolean,
  latencyMs: number,
): Promise<ProviderHealthState> {
  const prev = parseHealth(await redis.get(healthKey(provider))) ?? {
    errorRate: 0,
    latencyMs,
  };
  const next: ProviderHealthState = {
    errorRate:
      HEALTH_ALPHA * (ok ? 0 : 1) + (1 - HEALTH_ALPHA) * prev.errorRate,
    latencyMs: HEALTH_ALPHA * latencyMs + (1 - HEALTH_ALPHA) * prev.latencyMs,
  };
  await redis.set(healthKey(provider), JSON.stringify(next), {
    ex: HEALTH_TTL_S,
  });
  return next;
}

export async function readHealth(
  redis: RedisLike,
  providers: ProviderId[],
): Promise<HealthState> {
  const entries = await Promise.all(
    providers.map(async (p) => [p, parseHealth(await redis.get(healthKey(p)))] as const),
  );
  const out: HealthState = {};
  for (const [p, h] of entries) if (h) out[p] = h;
  return out;
}

// ---------------------------------------------------------------------------
// Playground demo limiter (per-IP, 5/day)
// ---------------------------------------------------------------------------

export interface DemoLimitResult {
  allowed: boolean;
  used: number;
  remaining: number;
  limit: number;
}

/** Consume one demo request for this IP hash. Counts even when denied. */
export async function consumeDemoLimit(
  redis: RedisLike,
  ipHash: string,
  limit: number = DEMO_DAILY_LIMIT,
  now: number = Date.now(),
): Promise<DemoLimitResult> {
  const used = await incrWithTtl(
    redis,
    demoKey(ipHash),
    1,
    secondsToMidnightUtc(now),
  );
  return {
    allowed: used <= limit,
    used: Math.min(used, limit),
    remaining: Math.max(0, limit - used),
    limit,
  };
}

/** Read the demo counter without consuming. */
export async function peekDemoLimit(
  redis: RedisLike,
  ipHash: string,
  limit: number = DEMO_DAILY_LIMIT,
): Promise<DemoLimitResult> {
  const used = asCount(await redis.get(demoKey(ipHash)));
  return {
    allowed: used < limit,
    used: Math.min(used, limit),
    remaining: Math.max(0, limit - used),
    limit,
  };
}
