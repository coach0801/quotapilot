/**
 * GET /api/status — latest provider snapshots (public JSON, CDN-cached 5 min).
 */

import { NextResponse } from "next/server";

import { PROVIDERS, PROVIDER_LIST } from "@/config/providers";
import { isProviderId } from "@/core/types";
import { getDb } from "@/db/client";
import { latestSnapshots } from "@/db/queries";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const snapshots = await latestSnapshots(getDb()).catch(() => []);
  const byProvider = new Map(snapshots.map((s) => [s.provider, s]));

  const providers = PROVIDER_LIST.map((p) => {
    const snap = byProvider.get(p.id);
    return {
      id: p.id,
      name: p.name,
      ok: snap?.ok ?? null,
      latencyMs: snap?.latencyMs ?? null,
      httpStatus: snap?.httpStatus ?? null,
      lastCheckedAt: snap?.ts?.toISOString?.() ?? null,
      limits: snap?.advertisedLimits ?? PROVIDERS[p.id].limits,
      models: p.models,
      note: snap?.note ?? null,
    };
  });

  // Snapshots may contain providers no longer in the config — surface them
  // too so the board reflects reality rather than our catalog.
  for (const s of snapshots) {
    if (!isProviderId(s.provider)) {
      providers.push({
        id: s.provider as never,
        name: s.provider,
        ok: s.ok,
        latencyMs: s.latencyMs,
        httpStatus: s.httpStatus,
        lastCheckedAt: s.ts?.toISOString?.() ?? null,
        limits: s.advertisedLimits ?? { rpm: 0, rpd: 0, tpm: 0 },
        models: [],
        note: s.note,
      });
    }
  }

  return NextResponse.json(
    { updatedAt: new Date().toISOString(), providers },
    {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60",
      },
    },
  );
}
