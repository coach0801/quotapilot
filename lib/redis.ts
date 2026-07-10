/**
 * Redis client factory. Uses Upstash when configured; otherwise falls back
 * to an in-memory implementation so local dev / preview deployments work
 * without external services (counters then reset per instance — fine for
 * dev, documented in /docs).
 */

import { Redis } from "@upstash/redis";

import type { RedisLike } from "@/core/quota";

interface MemEntry {
  value: string | number;
  expiresAt: number | null;
}

/** Minimal in-memory RedisLike with TTL semantics (dev fallback + tests). */
export function createMemoryRedis(clock: () => number = Date.now): RedisLike {
  const store = new Map<string, MemEntry>();

  const live = (key: string): MemEntry | undefined => {
    const e = store.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== null && e.expiresAt <= clock()) {
      store.delete(key);
      return undefined;
    }
    return e;
  };

  return {
    async incr(key) {
      return this.incrby(key, 1);
    },
    async incrby(key, by) {
      const e = live(key);
      const next = (e ? Number(e.value) : 0) + by;
      store.set(key, { value: next, expiresAt: e?.expiresAt ?? null });
      return next;
    },
    async expire(key, seconds) {
      const e = live(key);
      if (!e) return 0;
      e.expiresAt = clock() + seconds * 1000;
      return 1;
    },
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, opts) {
      const ttlMs =
        opts?.px !== undefined
          ? opts.px
          : opts?.ex !== undefined
            ? opts.ex * 1000
            : null;
      store.set(key, {
        value,
        expiresAt: ttlMs === null ? null : clock() + ttlMs,
      });
      return "OK";
    },
    async ttl(key) {
      const e = live(key);
      if (!e) return -2;
      if (e.expiresAt === null) return -1;
      return Math.max(1, Math.ceil((e.expiresAt - clock()) / 1000));
    },
  };
}

let cached: RedisLike | undefined;

export function getRedis(): RedisLike {
  if (cached) return cached;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  cached =
    url && token
      ? (new Redis({ url, token }) as unknown as RedisLike)
      : createMemoryRedis();
  return cached;
}
