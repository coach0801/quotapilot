import { describe, expect, it } from "vitest";

import {
  DEMO_DAILY_LIMIT,
  bumpUsage,
  consumeDemoLimit,
  markExhausted,
  peekDemoLimit,
  readHealth,
  readQuota,
  recordHealth,
  secondsToMidnightUtc,
  sha256Hex,
  syncDailyFromSnapshot,
} from "@/core/quota";
import { createMemoryRedis } from "@/lib/redis";

const KEY_HASH = "abc123";
const NOON_UTC = Date.UTC(2026, 6, 10, 12, 0, 0); // 2026-07-10T12:00:00Z

function fixture() {
  let now = NOON_UTC;
  const clock = () => now;
  const redis = createMemoryRedis(clock);
  return { redis, clock, advance: (ms: number) => (now += ms), now: () => now };
}

describe("secondsToMidnightUtc", () => {
  it("counts down to the next UTC midnight", () => {
    expect(secondsToMidnightUtc(NOON_UTC)).toBe(12 * 3600);
    expect(secondsToMidnightUtc(Date.UTC(2026, 6, 10, 23, 59, 59))).toBe(1);
  });
});

describe("sha256Hex", () => {
  it("matches a known vector", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("usage counters", () => {
  it("bumps rpm/rpd/tpm and reads them back", async () => {
    const { redis, now } = fixture();
    await bumpUsage(redis, KEY_HASH, "groq", 120, now());
    await bumpUsage(redis, KEY_HASH, "groq", 80, now());
    const state = await readQuota(redis, { groq: KEY_HASH }, now());
    expect(state.groq).toMatchObject({ rpmUsed: 2, rpdUsed: 2, tpmUsed: 200 });
    expect(state.groq!.rpmResetMs).toBeLessThanOrEqual(60_000);
    expect(state.groq!.rpdResetMs).toBe(12 * 3600 * 1000);
  });

  it("expires the RPM window after 60s but keeps the daily counter", async () => {
    const { redis, advance, now } = fixture();
    await bumpUsage(redis, KEY_HASH, "groq", 50, now());
    advance(61_000);
    const state = await readQuota(redis, { groq: KEY_HASH }, now());
    expect(state.groq).toMatchObject({ rpmUsed: 0, tpmUsed: 0, rpdUsed: 1 });
  });

  it("expires the daily counter at midnight UTC", async () => {
    const { redis, advance, now } = fixture();
    await bumpUsage(redis, KEY_HASH, "groq", 10, now());
    advance(12 * 3600 * 1000 + 1000); // past midnight
    const state = await readQuota(redis, { groq: KEY_HASH }, now());
    expect(state.groq!.rpdUsed).toBe(0);
  });

  it("tracks quota independently per key hash and provider", async () => {
    const { redis, now } = fixture();
    await bumpUsage(redis, "hash-a", "groq", 10, now());
    await bumpUsage(redis, "hash-b", "groq", 10, now());
    await bumpUsage(redis, "hash-a", "mistral", 10, now());
    const a = await readQuota(redis, { groq: "hash-a", mistral: "hash-a" }, now());
    const b = await readQuota(redis, { groq: "hash-b", mistral: "hash-b" }, now());
    expect(a.groq!.rpdUsed).toBe(1);
    expect(a.mistral!.rpdUsed).toBe(1);
    expect(b.groq!.rpdUsed).toBe(1);
    expect(b.mistral!.rpdUsed).toBe(0);
  });
});

describe("exhaustion marks", () => {
  it("sets and expires the exhausted flag", async () => {
    const { redis, advance, now } = fixture();
    await markExhausted(redis, KEY_HASH, "groq", 30_000);
    let state = await readQuota(redis, { groq: KEY_HASH }, now());
    expect(state.groq!.exhaustedForMs).toBeGreaterThan(0);
    advance(31_000);
    state = await readQuota(redis, { groq: KEY_HASH }, now());
    expect(state.groq!.exhaustedForMs).toBeUndefined();
  });
});

describe("syncDailyFromSnapshot", () => {
  it("reconciles the daily counter with authoritative headers", async () => {
    const { redis, now } = fixture();
    await bumpUsage(redis, KEY_HASH, "groq", 10, now());
    await syncDailyFromSnapshot(
      redis,
      KEY_HASH,
      "groq",
      { limitRequests: 14_400, remainingRequests: 14_000 },
      now(),
    );
    const state = await readQuota(redis, { groq: KEY_HASH }, now());
    expect(state.groq!.rpdUsed).toBe(400);
  });

  it("ignores snapshots without request info", async () => {
    const { redis, now } = fixture();
    await bumpUsage(redis, KEY_HASH, "groq", 10, now());
    await syncDailyFromSnapshot(redis, KEY_HASH, "groq", { limitTokens: 6000 }, now());
    const state = await readQuota(redis, { groq: KEY_HASH }, now());
    expect(state.groq!.rpdUsed).toBe(1);
  });
});

describe("health EWMA", () => {
  it("moves toward failure on errors and recovers on successes", async () => {
    const { redis } = fixture();
    let h = await recordHealth(redis, "groq", true, 200);
    expect(h.errorRate).toBe(0);
    h = await recordHealth(redis, "groq", false, 1000);
    expect(h.errorRate).toBeCloseTo(0.2);
    h = await recordHealth(redis, "groq", false, 1000);
    expect(h.errorRate).toBeCloseTo(0.36);
    h = await recordHealth(redis, "groq", true, 200);
    expect(h.errorRate).toBeCloseTo(0.288);
    const state = await readHealth(redis, ["groq", "gemini"]);
    expect(state.groq!.errorRate).toBeCloseTo(0.288);
    expect(state.gemini).toBeUndefined();
  });
});

describe("demo limiter", () => {
  it(`allows ${DEMO_DAILY_LIMIT} requests per IP per day, then denies`, async () => {
    const { redis, now } = fixture();
    for (let i = 1; i <= DEMO_DAILY_LIMIT; i++) {
      const r = await consumeDemoLimit(redis, "ip-hash", DEMO_DAILY_LIMIT, now());
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(DEMO_DAILY_LIMIT - i);
    }
    const denied = await consumeDemoLimit(redis, "ip-hash", DEMO_DAILY_LIMIT, now());
    expect(denied).toMatchObject({ allowed: false, remaining: 0 });
  });

  it("resets at midnight UTC and is independent per IP", async () => {
    const { redis, advance, now } = fixture();
    for (let i = 0; i < DEMO_DAILY_LIMIT + 1; i++) {
      await consumeDemoLimit(redis, "ip-a", DEMO_DAILY_LIMIT, now());
    }
    expect((await peekDemoLimit(redis, "ip-a")).allowed).toBe(false);
    expect((await peekDemoLimit(redis, "ip-b")).allowed).toBe(true);
    advance(12 * 3600 * 1000 + 1000);
    expect((await peekDemoLimit(redis, "ip-a")).allowed).toBe(true);
  });
});
