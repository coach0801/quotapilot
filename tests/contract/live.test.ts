/**
 * Live smoke tests — one real "ping" completion per adapter using the
 * demo-pool keys. Gated behind QP_LIVE=1; runs in the nightly CI schedule,
 * never on PRs (spec §9).
 */

import { describe, expect, it } from "vitest";

import { ADAPTERS } from "@/adapters";
import { PROVIDER_LIST, demoKeyFor } from "@/config/providers";
import type { NormalizedChatResponse, NormalizedChunk } from "@/core/types";
import { collect } from "./helpers";

const LIVE = process.env.QP_LIVE === "1";

describe.skipIf(!LIVE)("live adapter smoke (real APIs, demo keys)", () => {
  for (const config of PROVIDER_LIST) {
    const key = demoKeyFor(config.id);
    const model =
      config.models.find((m) => m.modelClass === "fast") ?? config.models[0];

    describe.skipIf(!key)(config.id, () => {
      it("completes a non-streaming ping", async () => {
        const res = (await ADAPTERS[config.id].chat(
          {
            model: model.id,
            messages: [{ role: "user", content: "Reply with the word: pong" }],
            maxTokens: 16,
            stream: false,
          },
          key!,
          AbortSignal.timeout(30_000),
        )) as NormalizedChatResponse;
        expect(typeof res.content).toBe("string");
        expect(res.content.length).toBeGreaterThan(0);
      }, 45_000);

      it("completes a streaming ping", async () => {
        const stream = (await ADAPTERS[config.id].chat(
          {
            model: model.id,
            messages: [{ role: "user", content: "Reply with the word: pong" }],
            maxTokens: 16,
            stream: true,
          },
          key!,
          AbortSignal.timeout(30_000),
        )) as ReadableStream<NormalizedChunk>;
        const chunks = await collect(stream);
        expect(chunks.map((c) => c.delta).join("").length).toBeGreaterThan(0);
      }, 45_000);
    });
  }
});
