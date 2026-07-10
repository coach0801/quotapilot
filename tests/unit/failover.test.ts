import { describe, expect, it, vi } from "vitest";

import { runFailover, type FailoverDeps } from "@/core/failover";
import type { RouteCandidate } from "@/core/router";
import { AdapterHttpError, type ErrorClass } from "@/core/types";

const candidates: RouteCandidate[] = [
  { provider: "groq", model: "m1", score: 3 },
  { provider: "gemini", model: "m2", score: 2 },
  { provider: "mistral", model: "m3", score: 1 },
  { provider: "openrouter", model: "m4", score: 0.5 },
  { provider: "github-models", model: "m5", score: 0.25 },
];

function err(status: number) {
  return new AdapterHttpError("groq", status, "boom");
}

function classifyByStatus(_p: string, e: unknown): ErrorClass {
  const s = (e as AdapterHttpError).status;
  if (s === 429) return "rate_limited";
  if (s === 401) return "auth";
  if (s >= 500) return "server";
  return "client";
}

function deps<T>(
  execute: FailoverDeps<T>["execute"],
): FailoverDeps<T> & { sleeps: number[]; exhausted: string[] } {
  const sleeps: number[] = [];
  const exhausted: string[] = [];
  return {
    execute,
    classify: classifyByStatus,
    onExhausted: (c) => {
      exhausted.push(c.provider);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    sleeps,
    exhausted,
  };
}

describe("runFailover", () => {
  it("succeeds on the first candidate with fallbackDepth 0", async () => {
    const d = deps(async () => "hello");
    const result = await runFailover(candidates, d);
    expect(result).toMatchObject({ ok: true, value: "hello", provider: "groq", fallbackDepth: 0 });
    expect(d.sleeps).toEqual([]);
  });

  it("429 → marks exhausted and moves to the next provider immediately", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(err(429))
      .mockResolvedValueOnce("from-gemini");
    const d = deps(execute);
    const result = await runFailover(candidates, d);
    expect(result).toMatchObject({ ok: true, provider: "gemini", fallbackDepth: 1 });
    expect(d.exhausted).toEqual(["groq"]);
    expect(d.sleeps).toEqual([]); // no backoff on rate limits
  });

  it("5xx → retries the SAME provider with 500ms/2s backoff before re-routing", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(err(500))
      .mockRejectedValueOnce(err(502))
      .mockResolvedValueOnce("third-time-lucky");
    const d = deps(execute);
    const result = await runFailover(candidates, d);
    expect(result).toMatchObject({ ok: true, provider: "groq", fallbackDepth: 0 });
    expect(d.sleeps).toEqual([500, 2000]);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("5xx exhausting retries → moves to next provider", async () => {
    const execute = vi.fn(async (c: RouteCandidate) => {
      if (c.provider === "groq") throw err(500);
      return `ok-${c.provider}`;
    });
    const d = deps(execute);
    const result = await runFailover(candidates, d);
    expect(result).toMatchObject({ ok: true, provider: "gemini", fallbackDepth: 1 });
    expect(d.sleeps).toEqual([500, 2000]); // 2 retries on groq
    expect(execute).toHaveBeenCalledTimes(4); // 3× groq + 1× gemini
  });

  it("400 (client) → stops immediately and surfaces to caller", async () => {
    const execute = vi.fn().mockRejectedValue(err(400));
    const d = deps(execute);
    const result = await runFailover(candidates, d);
    expect(result).toMatchObject({ ok: false, reason: "client", provider: "groq", fallbackDepth: 0 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(d.exhausted).toEqual([]);
  });

  it("401 (auth) → stops immediately", async () => {
    const execute = vi.fn().mockRejectedValue(err(401));
    const result = await runFailover(candidates, deps(execute));
    expect(result).toMatchObject({ ok: false, reason: "auth" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("caps at max fallback depth 3 (4 providers tried out of 5)", async () => {
    const tried: string[] = [];
    const execute = vi.fn(async (c: RouteCandidate) => {
      tried.push(c.provider);
      throw err(429);
    });
    const result = await runFailover(candidates, deps(execute));
    expect(result).toMatchObject({ ok: false, reason: "exhausted" });
    expect(tried).toEqual(["groq", "gemini", "mistral", "openrouter"]);
  });

  it("returns exhausted with the last error when every candidate fails", async () => {
    const boom = err(503);
    const execute = vi.fn().mockRejectedValue(boom);
    const result = await runFailover(candidates.slice(0, 2), deps(execute));
    expect(result).toMatchObject({
      ok: false,
      reason: "exhausted",
      error: boom,
      provider: "gemini",
    });
  });

  it("handles an empty candidate list", async () => {
    const execute = vi.fn();
    const result = await runFailover([], deps(execute));
    expect(result).toMatchObject({ ok: false, reason: "exhausted" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("mixed taxonomy: 429 → 5xx×3 → success on third provider", async () => {
    const execute = vi.fn(async (c: RouteCandidate) => {
      if (c.provider === "groq") throw err(429);
      if (c.provider === "gemini") throw err(500);
      return "mistral-wins";
    });
    const d = deps(execute);
    const result = await runFailover(candidates, d);
    expect(result).toMatchObject({ ok: true, provider: "mistral", fallbackDepth: 2 });
    expect(d.exhausted).toEqual(["groq"]);
    expect(d.sleeps).toEqual([500, 2000]);
  });
});
