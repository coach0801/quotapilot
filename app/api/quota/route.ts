/**
 * GET /api/quota — remaining quota for the caller's key set.
 * Requires BYOK keys in the x-qp-keys header (spec §6); keys are hashed,
 * never stored, never logged.
 */

import { NextResponse } from "next/server";

import { PROVIDERS } from "@/config/providers";
import { openAiError } from "@/core/normalize";
import { readQuota } from "@/core/quota";
import type { ProviderId } from "@/core/types";
import { hashKeySet, parseByokHeader } from "@/lib/keys";
import { getRedis } from "@/lib/redis";

export const runtime = "edge";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const keys = parseByokHeader(req.headers.get("x-qp-keys"));
  if (keys === null) {
    return NextResponse.json(
      openAiError(
        'Malformed x-qp-keys header. Expected JSON like {"groq":"gsk_..."}.',
        "invalid_request_error",
      ),
      { status: 400 },
    );
  }
  if (Object.keys(keys).length === 0) {
    return NextResponse.json(
      openAiError(
        "BYOK headers required: pass your provider keys in x-qp-keys to read their quota.",
        "authentication_error",
      ),
      { status: 401 },
    );
  }

  const keyHashes = await hashKeySet(keys);
  const quota = await readQuota(getRedis(), keyHashes);

  const providers = (Object.keys(keyHashes) as ProviderId[]).map((id) => {
    const q = quota[id];
    const limits = PROVIDERS[id].limits;
    return {
      id,
      name: PROVIDERS[id].name,
      limits,
      used: {
        rpm: q?.rpmUsed ?? 0,
        rpd: q?.rpdUsed ?? 0,
        tpm: q?.tpmUsed ?? 0,
      },
      remaining: {
        rpm: Math.max(0, limits.rpm - (q?.rpmUsed ?? 0)),
        rpd: Math.max(0, limits.rpd - (q?.rpdUsed ?? 0)),
        tpm: Math.max(0, limits.tpm - (q?.tpmUsed ?? 0)),
      },
      resetsInMs: {
        rpm: q?.rpmResetMs ?? 60_000,
        rpd: q?.rpdResetMs ?? null,
      },
      exhaustedForMs: q?.exhaustedForMs ?? null,
    };
  });

  return NextResponse.json(
    { updatedAt: new Date().toISOString(), providers },
    { headers: { "Cache-Control": "no-store" } },
  );
}
