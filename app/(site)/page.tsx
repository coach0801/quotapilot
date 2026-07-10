/**
 * Landing page + live status board (ISR: hourly + on-demand revalidate
 * from the probe workflow).
 */

import Link from "next/link";

import { Sparkline, type SparkPoint } from "@/components/sparkline";
import { UptimeBar, type UptimeCell } from "@/components/uptime-bar";
import { PROVIDERS, PROVIDER_LIST } from "@/config/providers";
import type { ProviderLimits } from "@/core/types";
import { getDb } from "@/db/client";
import { latestSnapshots, recentSnapshots, uptimeByDay } from "@/db/queries";

export const revalidate = 3600;

function limitsOf(advertised: unknown, fallback: ProviderLimits): ProviderLimits {
  if (advertised && typeof advertised === "object") {
    const a = advertised as Partial<ProviderLimits>;
    return {
      rpm: a.rpm ?? fallback.rpm,
      rpd: a.rpd ?? fallback.rpd,
      tpm: a.tpm ?? fallback.tpm,
    };
  }
  return fallback;
}

function lastNDays(n: number): string[] {
  const out: string[] = [];
  const today = Date.now();
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(today - i * 24 * 3_600_000).toISOString().slice(0, 10));
  }
  return out;
}

export default async function Home() {
  const db = getDb();
  const [latest, recent, uptime] = await Promise.all([
    latestSnapshots(db).catch(() => []),
    recentSnapshots(db, 24).catch(() => []),
    uptimeByDay(db, 30).catch(() => []),
  ]);

  const latestBy = new Map(latest.map((s) => [s.provider, s]));
  const days = lastNDays(30);

  return (
    <div className="space-y-12">
      {/* Hero */}
      <section className="space-y-4 pt-6 text-center">
        <h1 className="text-4xl font-bold tracking-tight">
          One endpoint for every <span className="text-emerald-400">free</span>{" "}
          LLM API
        </h1>
        <p className="mx-auto max-w-2xl text-zinc-400">
          OpenAI-compatible gateway across Groq, Gemini, Mistral, OpenRouter and
          GitHub Models — with automatic failover, real-time quota tracking, and
          this live status board. Bring your own free keys; nothing is stored.
        </p>
        <div className="flex justify-center gap-3 pt-2">
          <Link
            href="/playground"
            className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400"
          >
            Try the playground
          </Link>
          <Link
            href="/docs"
            className="rounded-md border border-zinc-700 px-4 py-2 text-sm hover:border-zinc-500"
          >
            Quickstart
          </Link>
        </div>
        <pre className="mx-auto mt-4 max-w-2xl overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-left text-xs text-zinc-300">
          {`const client = new OpenAI({
  baseURL: "https://quotapilot.vercel.app/v1",
  apiKey: "unused",
  defaultHeaders: { "x-qp-keys": JSON.stringify({ groq: "gsk_..." }) },
});
await client.chat.completions.create({ model: "auto:fast", messages });`}
        </pre>
      </section>

      {/* Status board */}
      <section className="space-y-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xl font-semibold">Free-LLM status board</h2>
          <span className="text-xs text-zinc-500">
            probed hourly · updated{" "}
            {latest[0]?.ts ? new Date(latest[0].ts).toUTCString() : "—"}
          </span>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {PROVIDER_LIST.map((p) => {
            const snap = latestBy.get(p.id);
            const limits = limitsOf(snap?.advertisedLimits, PROVIDERS[p.id].limits);
            const spark: SparkPoint[] = recent
              .filter((s) => s.provider === p.id)
              .map((s) => ({
                ts: new Date(s.ts).toISOString(),
                latencyMs: s.latencyMs,
              }));
            const upByDay = new Map(
              uptime
                .filter((u) => u.provider === p.id)
                .map((u) => [u.day, u.total > 0 ? u.up / u.total : null]),
            );
            const cells: UptimeCell[] = days.map((day) => ({
              day,
              ratio: upByDay.get(day) ?? null,
            }));
            return (
              <div
                key={p.id}
                className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4"
              >
                <div className="flex items-center justify-between">
                  <div className="font-medium">{p.name}</div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      snap === undefined
                        ? "bg-zinc-800 text-zinc-400"
                        : snap.ok
                          ? "bg-emerald-500/15 text-emerald-400"
                          : "bg-red-500/15 text-red-400"
                    }`}
                  >
                    {snap === undefined ? "no data" : snap.ok ? "operational" : "down"}
                  </span>
                </div>
                <Sparkline data={spark} />
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>
                    latency{" "}
                    {snap?.latencyMs != null ? `${snap.latencyMs} ms` : "—"}
                  </span>
                  <span>
                    {limits.rpm} RPM · {limits.rpd.toLocaleString()} req/day
                  </span>
                </div>
                <UptimeBar cells={cells} />
                <div className="text-xs text-zinc-500">
                  last checked:{" "}
                  {snap?.ts ? new Date(snap.ts).toUTCString() : "never"}
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-zinc-500">
          Limits are defaults from{" "}
          <code className="text-zinc-400">config/providers.ts</code>, corrected
          live from provider rate-limit headers. JSON feed:{" "}
          <Link href="/api/status" className="text-emerald-400 hover:underline">
            /api/status
          </Link>
        </p>
      </section>
    </div>
  );
}
