"use client";

/**
 * Quota dashboard (spec §8 step 28): per-provider burn-down bars from
 * /api/quota, using the BYOK keys stored in this browser's localStorage.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { useLocalKeys } from "@/lib/use-local-keys";

interface QuotaProvider {
  id: string;
  name: string;
  limits: { rpm: number; rpd: number; tpm: number };
  used: { rpm: number; rpd: number; tpm: number };
  remaining: { rpm: number; rpd: number; tpm: number };
  resetsInMs: { rpm: number; rpd: number | null };
  exhaustedForMs: number | null;
}

function Bar({
  label,
  used,
  limit,
  remaining,
}: {
  label: string;
  used: number;
  limit: number;
  remaining: number;
}) {
  const frac = limit > 0 ? Math.min(1, used / limit) : 0;
  const color =
    frac < 0.6 ? "bg-emerald-500" : frac < 0.9 ? "bg-amber-400" : "bg-red-500";
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-zinc-400">
        <span>{label}</span>
        <span>
          ~{remaining.toLocaleString()} left of {limit.toLocaleString()}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded bg-zinc-800">
        <div className={`h-full ${color}`} style={{ width: `${frac * 100}%` }} />
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [providers, setProviders] = useState<QuotaProvider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { activeKeys } = useLocalKeys();
  const hasKeys = Object.keys(activeKeys).length > 0;

  const refresh = useCallback(async () => {
    if (Object.keys(activeKeys).length === 0) return;
    try {
      const res = await fetch("/api/quota", {
        headers: { "x-qp-keys": JSON.stringify(activeKeys) },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setProviders(body.providers);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [activeKeys]);

  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => void refresh(), 15_000);
    return () => {
      clearTimeout(initial);
      clearInterval(t);
    };
  }, [refresh]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Quota dashboard</h1>
        <button
          onClick={() => void refresh()}
          className="rounded border border-zinc-700 px-3 py-1 text-sm hover:border-zinc-500"
        >
          refresh
        </button>
      </div>

      {!hasKeys && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-6 text-sm text-zinc-400">
          No keys found in this browser. Add your free provider keys in the{" "}
          <Link href="/playground" className="text-emerald-400 hover:underline">
            playground key manager
          </Link>{" "}
          — quota is tracked per key (by SHA-256 hash), never stored server-side.
        </div>
      )}

      {error && (
        <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {providers && (
        <div className="grid gap-4 sm:grid-cols-2">
          {providers.map((p) => (
            <div
              key={p.id}
              className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{p.name}</span>
                {p.exhaustedForMs !== null ? (
                  <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs text-red-400">
                    exhausted · resets in {Math.ceil(p.exhaustedForMs / 1000)}s
                  </span>
                ) : (
                  <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-400">
                    ~{p.remaining.rpd.toLocaleString()} requests left today
                  </span>
                )}
              </div>
              <Bar label="requests / day" used={p.used.rpd} limit={p.limits.rpd} remaining={p.remaining.rpd} />
              <Bar label="requests / min" used={p.used.rpm} limit={p.limits.rpm} remaining={p.remaining.rpm} />
              <Bar label="tokens / min" used={p.used.tpm} limit={p.limits.tpm} remaining={p.remaining.tpm} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
