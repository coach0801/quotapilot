/**
 * Hourly provider probe (spec §8 step 22) — run by GitHub Actions
 * (.github/workflows/probe.yml), which then hits POST /api/revalidate.
 *
 * For each provider with a demo key: one minimal completion ("ping"),
 * measure latency, capture rate-limit headers, write a snapshot row.
 * Failures are DATA (ok=false rows), never a script crash.
 */

import { ADAPTERS } from "../adapters";
import { PROVIDERS, PROVIDER_LIST, demoKeyFor } from "../config/providers";
import type {
  NormalizedChatResponse,
  ProviderConfig,
  RateLimitSnapshot,
} from "../core/types";
import { AdapterHttpError } from "../core/types";
import { getDb } from "../db/client";
import { insertSnapshot } from "../db/queries";

const PROBE_TIMEOUT_MS = 30_000;

interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  httpStatus: number | null;
  headerSnapshot: RateLimitSnapshot | null;
  note: string | null;
}

async function probeProvider(
  config: ProviderConfig,
  key: string,
): Promise<ProbeResult> {
  const adapter = ADAPTERS[config.id];
  const model =
    config.models.find((m) => m.modelClass === "fast") ?? config.models[0];
  const t0 = Date.now();
  try {
    const res = (await adapter.chat(
      {
        model: model.id,
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 8,
        stream: false,
      },
      key,
      AbortSignal.timeout(PROBE_TIMEOUT_MS),
    )) as NormalizedChatResponse;
    return {
      ok: true,
      latencyMs: Date.now() - t0,
      httpStatus: 200,
      headerSnapshot: res.rateLimit ?? null,
      note: `model=${model.id}`,
    };
  } catch (e) {
    const latencyMs = Date.now() - t0;
    if (e instanceof AdapterHttpError) {
      return {
        ok: false,
        latencyMs,
        httpStatus: e.status,
        headerSnapshot: null,
        note: `model=${model.id} — ${e.body.slice(0, 200)}`,
      };
    }
    return {
      ok: false,
      latencyMs,
      httpStatus: null,
      headerSnapshot: null,
      note: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    };
  }
}

async function main() {
  const db = getDb();
  if (!db) {
    console.error("DATABASE_URL not set — snapshots cannot be written.");
    process.exitCode = 1;
    return;
  }

  for (const config of PROVIDER_LIST) {
    const key = demoKeyFor(config.id);
    if (!key) {
      console.warn(`[${config.id}] no demo key configured — skipping`);
      continue;
    }
    const result = await probeProvider(config, key);
    await insertSnapshot(db, {
      provider: config.id,
      ok: result.ok,
      latencyMs: result.latencyMs,
      httpStatus: result.httpStatus,
      advertisedLimits: {
        ...PROVIDERS[config.id].limits,
        headers: result.headerSnapshot,
      },
      note: result.note,
    });
    console.log(
      `[${config.id}] ${result.ok ? "OK" : "DOWN"} ${result.latencyMs}ms` +
        (result.httpStatus !== null ? ` (HTTP ${result.httpStatus})` : ""),
    );
  }
}

main().catch((e) => {
  // Even a total failure should exit cleanly enough for the workflow's
  // revalidate step to be skipped, not retried in a loop.
  console.error("probe failed:", e);
  process.exitCode = 1;
});
