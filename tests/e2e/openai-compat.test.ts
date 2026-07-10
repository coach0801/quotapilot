/**
 * E2E compatibility contract (spec §8 step 21): the OFFICIAL `openai` npm
 * client pointed at a running QuotaPilot deployment with only `baseURL`
 * changed must complete a chat and a streamed chat.
 *
 * Gated behind QP_E2E_BASE_URL (e.g. http://localhost:3000 or a preview
 * deploy). Provide keys via QP_E2E_KEYS='{"groq":"gsk_..."}'.
 */

import OpenAI from "openai";
import { describe, expect, it } from "vitest";

const BASE = process.env.QP_E2E_BASE_URL;
const KEYS = process.env.QP_E2E_KEYS;

describe.skipIf(!BASE || !KEYS)("openai SDK compatibility (e2e)", () => {
  const client = new OpenAI({
    baseURL: `${BASE}/v1`,
    apiKey: "unused",
    defaultHeaders: { "x-qp-keys": KEYS! },
  });

  it("completes a non-streaming chat", async () => {
    const res = await client.chat.completions.create({
      model: "auto:fast",
      messages: [{ role: "user", content: "Reply with the word: pong" }],
      max_tokens: 16,
    });
    expect(res.object).toBe("chat.completion");
    expect(res.choices[0].message.role).toBe("assistant");
    expect(res.choices[0].message.content!.length).toBeGreaterThan(0);
  }, 60_000);

  it("completes a streaming chat", async () => {
    const stream = await client.chat.completions.create({
      model: "auto:fast",
      messages: [{ role: "user", content: "Count to three." }],
      max_tokens: 32,
      stream: true,
    });
    let text = "";
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? "";
    }
    expect(text.length).toBeGreaterThan(0);
  }, 60_000);

  it("propagates x-qp-* headers", async () => {
    const res = await client.chat.completions
      .create({
        model: "auto:fast",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
      })
      .withResponse();
    expect(res.response.headers.get("x-qp-provider")).toBeTruthy();
    expect(res.response.headers.get("x-qp-fallback-depth")).toMatch(/^\d$/);
    const remaining = JSON.parse(res.response.headers.get("x-qp-remaining") ?? "{}");
    expect(Object.keys(remaining).length).toBeGreaterThan(0);
  }, 60_000);
});
