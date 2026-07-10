import { describe, expect, it } from "vitest";

import { PROVIDERS, RELIABILITY_ORDER } from "@/config/providers";
import { parseModelSelector, route, type RouteInput } from "@/core/router";
import type { ProviderId, QuotaState } from "@/core/types";

const ALL: ProviderId[] = ["groq", "gemini", "mistral", "openrouter", "github-models"];

function input(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    model: "auto:fast",
    quota: {},
    health: {},
    config: PROVIDERS,
    availableProviders: ALL,
    reliabilityOrder: RELIABILITY_ORDER,
    ...overrides,
  };
}

/** Quota state representing an exhausted daily budget for a provider. */
function rpdExhausted(provider: ProviderId, rpdResetMs = 3_600_000) {
  return {
    [provider]: {
      rpmUsed: 0,
      rpdUsed: PROVIDERS[provider].limits.rpd,
      tpmUsed: 0,
      rpmResetMs: 30_000,
      rpdResetMs,
    },
  } satisfies QuotaState;
}

describe("parseModelSelector", () => {
  it("maps auto and auto:<class> to class selectors", () => {
    expect(parseModelSelector("auto", PROVIDERS)).toEqual({ kind: "class", modelClass: "fast" });
    expect(parseModelSelector("auto:strong", PROVIDERS)).toEqual({ kind: "class", modelClass: "strong" });
    expect(parseModelSelector("auto:reasoning", PROVIDERS)).toEqual({ kind: "class", modelClass: "reasoning" });
    expect(parseModelSelector("auto:hyperspeed", PROVIDERS)).toEqual({ kind: "unknown" });
  });

  it("resolves provider-pinned ids", () => {
    expect(parseModelSelector("groq/llama-3.3-70b-versatile", PROVIDERS)).toEqual({
      kind: "pinned",
      provider: "groq",
      model: "llama-3.3-70b-versatile",
    });
    expect(parseModelSelector("groq/not-a-model", PROVIDERS)).toEqual({ kind: "unknown" });
  });

  it("resolves bare catalog ids, including ids that contain slashes", () => {
    expect(parseModelSelector("mistral-small-latest", PROVIDERS)).toEqual({
      kind: "named",
      model: "mistral-small-latest",
    });
    // OpenRouter-native id with a slash whose prefix is NOT a provider id
    expect(parseModelSelector("meta-llama/llama-3.3-70b-instruct:free", PROVIDERS)).toEqual({
      kind: "named",
      model: "meta-llama/llama-3.3-70b-instruct:free",
    });
    expect(parseModelSelector("gpt-42-ultra", PROVIDERS)).toEqual({ kind: "unknown" });
  });
});

describe("route", () => {
  it("ranks every provider with a matching class model when quota is fresh", () => {
    const result = route(input({ model: "auto:fast" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // gemini has no dedicated "fast"? it does (flash-lite). All 5 have fast models.
    expect(result.candidates.map((c) => c.provider).sort()).toEqual([...ALL].sort());
    // each candidate got that provider's fast-class model
    for (const c of result.candidates) {
      const m = PROVIDERS[c.provider].models.find((x) => x.id === c.model);
      expect(m?.modelClass).toBe("fast");
    }
  });

  it("substitutes equivalent-class models across providers (failover semantics)", () => {
    const result = route(input({ model: "auto:reasoning" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // only providers with a reasoning-class model are eligible
    const eligible = ALL.filter((p) =>
      PROVIDERS[p].models.some((m) => m.modelClass === "reasoning"),
    );
    expect(result.candidates.map((c) => c.provider).sort()).toEqual(eligible.sort());
  });

  it("excludes providers whose daily budget is exhausted", () => {
    const result = route(input({ model: "auto:fast", quota: rpdExhausted("groq") }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.some((c) => c.provider === "groq")).toBe(false);
  });

  it("excludes providers with an exhausted mark from failover", () => {
    const quota: QuotaState = {
      groq: { rpmUsed: 0, rpdUsed: 0, tpmUsed: 0, rpmResetMs: 60_000, rpdResetMs: 1, exhaustedForMs: 30_000 },
    };
    const result = route(input({ model: "auto:fast", quota }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.some((c) => c.provider === "groq")).toBe(false);
  });

  it("ranks lower-headroom providers below fresh ones", () => {
    const quota: QuotaState = {
      groq: {
        rpmUsed: 29, // 1/30 headroom left
        rpdUsed: 0,
        tpmUsed: 0,
        rpmResetMs: 10_000,
        rpdResetMs: 3_600_000,
      },
    };
    const result = route(input({ model: "auto:fast", quota }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const groqIdx = result.candidates.findIndex((c) => c.provider === "groq");
    expect(groqIdx).toBe(result.candidates.length - 1);
  });

  it("degrades ranking when health worsens", () => {
    const healthy = route(input({ model: "auto:strong" }));
    expect(healthy.ok).toBe(true);
    if (!healthy.ok) return;
    const top = healthy.candidates[0].provider;

    const degraded = route(
      input({
        model: "auto:strong",
        health: { [top]: { errorRate: 0.9, latencyMs: 5000 } },
      }),
    );
    expect(degraded.ok).toBe(true);
    if (!degraded.ok) return;
    expect(degraded.candidates[0].provider).not.toBe(top);
    expect(degraded.candidates[degraded.candidates.length - 1].provider).toBe(top);
  });

  it("returns 429 semantics with soonest reset when ALL providers are exhausted", () => {
    const quota: QuotaState = {};
    for (const p of ALL) {
      quota[p] = {
        rpmUsed: 0,
        rpdUsed: PROVIDERS[p].limits.rpd,
        tpmUsed: 0,
        rpmResetMs: 60_000,
        rpdResetMs: p === "mistral" ? 120_000 : 7_200_000, // mistral resets soonest
      };
    }
    const result = route(input({ model: "auto:fast", quota }));
    expect(result).toEqual({ ok: false, reason: "exhausted", retryAfterMs: 120_000 });
  });

  it("treats TPM exhaustion as a minute-window exclusion", () => {
    const quota: QuotaState = {
      groq: {
        rpmUsed: 0,
        rpdUsed: 0,
        tpmUsed: PROVIDERS.groq.limits.tpm,
        rpmResetMs: 15_000,
        rpdResetMs: 3_600_000,
      },
    };
    const result = route(
      input({ model: "auto:fast", quota, availableProviders: ["groq"] }),
    );
    expect(result).toEqual({ ok: false, reason: "exhausted", retryAfterMs: 15_000 });
  });

  it("pins to a single provider for provider/model ids", () => {
    const result = route(input({ model: "groq/llama-3.3-70b-versatile" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      provider: "groq",
      model: "llama-3.3-70b-versatile",
    });
  });

  it("returns unknown_model for garbage and unsupported when key set lacks the provider", () => {
    expect(route(input({ model: "gpt-42-ultra" }))).toEqual({
      ok: false,
      reason: "unknown_model",
    });
    expect(
      route(
        input({
          model: "groq/llama-3.3-70b-versatile",
          availableProviders: ["gemini"],
        }),
      ),
    ).toEqual({ ok: false, reason: "unsupported" });
  });

  it("breaks score ties by reliability order", () => {
    const result = route(input({ model: "auto:fast", health: {} }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // fresh quota + default health ⇒ all scores equal ⇒ reliability order wins
    expect(result.candidates[0].provider).toBe("groq");
  });
});
