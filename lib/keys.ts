/**
 * BYOK key-set resolution, shared by the gateway and /api/quota.
 *
 * Keys arrive per request in the `x-qp-keys` header and are NEVER
 * persisted — only their SHA-256 hashes are used (as Redis counter keys).
 */

import { byokKeysSchema } from "@/core/normalize";
import { sha256Hex } from "@/core/quota";
import { isProviderId, type ProviderId } from "@/core/types";

export type KeySet = Partial<Record<ProviderId, string>>;
export type KeyHashSet = Partial<Record<ProviderId, string>>;

/**
 * Parse the x-qp-keys header. Returns null on malformed input (caller
 * responds 400) and an empty object when the header is absent.
 */
export function parseByokHeader(header: string | null): KeySet | null {
  if (header === null || header.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(header);
  } catch {
    return null;
  }
  const result = byokKeysSchema.safeParse(parsed);
  if (!result.success) return null;
  const out: KeySet = {};
  for (const [k, v] of Object.entries(result.data)) {
    if (isProviderId(k)) out[k] = v;
  }
  return out;
}

export async function hashKeySet(keys: KeySet): Promise<KeyHashSet> {
  const entries = await Promise.all(
    (Object.entries(keys) as [ProviderId, string][]).map(
      async ([p, key]) => [p, await sha256Hex(key)] as const,
    ),
  );
  return Object.fromEntries(entries);
}

/** Client IP for the demo limiter (hashed before any storage; never logged). */
export function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return headers.get("x-real-ip") ?? "unknown";
}

/** Is this request coming from our own playground UI (same-origin)? */
export function isPlaygroundOrigin(headers: Headers, requestUrl: string): boolean {
  const source = headers.get("origin") ?? headers.get("referer");
  if (!source) return false;
  try {
    return new URL(source).host === new URL(requestUrl).host;
  } catch {
    return false;
  }
}
