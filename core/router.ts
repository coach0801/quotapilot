/**
 * Router core — pure scoring/selection logic. NO I/O in this module:
 * quota state, health state, and config are all injected, so unit tests
 * cover headroom exhaustion, model-class substitution, health degradation,
 * and the all-exhausted case deterministically.
 *
 *   score(provider) = headroom(RPM, RPD, TPM)
 *                   × modelFit(requested model/class)
 *                   × healthScore(recent error rate, latency EWMA)
 */

import type {
  HealthState,
  ModelClass,
  ProviderConfig,
  ProviderId,
  QuotaState,
} from "./types";
import { MODEL_CLASSES, isProviderId } from "./types";

export interface RouteCandidate {
  provider: ProviderId;
  /** Concrete provider-native model id to call. */
  model: string;
  score: number;
}

export type RouteResult =
  | { ok: true; candidates: RouteCandidate[] }
  /** The requested model/class doesn't exist anywhere in the catalog. */
  | { ok: false; reason: "unknown_model" }
  /** Model exists, but no provider in the caller's key set serves it. */
  | { ok: false; reason: "unsupported" }
  /** All eligible providers are out of quota. Retry-After = soonest reset. */
  | { ok: false; reason: "exhausted"; retryAfterMs: number };

export type ModelSelector =
  | { kind: "class"; modelClass: ModelClass }
  | { kind: "pinned"; provider: ProviderId; model: string }
  | { kind: "named"; model: string }
  | { kind: "unknown" };

/**
 * Interpret the caller's `model` field:
 *   "auto" / "auto:fast" / "auto:strong" / "auto:reasoning"  → class
 *   "groq/llama-3.3-70b-versatile"                           → pinned provider
 *   "llama-3.3-70b-versatile"                                → any provider with it
 */
export function parseModelSelector(
  model: string,
  config: Record<ProviderId, ProviderConfig>,
): ModelSelector {
  if (model === "auto") return { kind: "class", modelClass: "fast" };
  if (model.startsWith("auto:")) {
    const cls = model.slice("auto:".length);
    if ((MODEL_CLASSES as readonly string[]).includes(cls)) {
      return { kind: "class", modelClass: cls as ModelClass };
    }
    return { kind: "unknown" };
  }
  const slash = model.indexOf("/");
  if (slash > 0) {
    const prefix = model.slice(0, slash);
    if (isProviderId(prefix)) {
      const rest = model.slice(slash + 1);
      const provider = config[prefix];
      if (provider?.models.some((m) => m.id === rest)) {
        return { kind: "pinned", provider: prefix, model: rest };
      }
      return { kind: "unknown" };
    }
    // Not a provider prefix — some native model ids contain "/" (e.g.
    // OpenRouter, GitHub Models); fall through to a catalog-wide lookup.
  }
  const exists = Object.values(config).some((p) =>
    p.models.some((m) => m.id === model),
  );
  return exists ? { kind: "named", model } : { kind: "unknown" };
}

const HEALTH_LATENCY_REF_MS = 1000;
const DEFAULT_HEALTH = { errorRate: 0, latencyMs: 500 };

function healthScore(health: HealthState, provider: ProviderId): number {
  const h = health[provider] ?? DEFAULT_HEALTH;
  const errFactor = Math.min(1, Math.max(0, 1 - h.errorRate));
  const latFactor =
    HEALTH_LATENCY_REF_MS / (HEALTH_LATENCY_REF_MS + Math.max(0, h.latencyMs));
  return errFactor * latFactor;
}

interface EligibleProvider {
  provider: ProviderId;
  model: string;
}

/** Providers (with the concrete model to use) that can serve this selector. */
function eligibleProviders(
  selector: ModelSelector,
  config: Record<ProviderId, ProviderConfig>,
  available: ProviderId[],
): EligibleProvider[] {
  const out: EligibleProvider[] = [];
  for (const id of available) {
    const p = config[id];
    if (!p) continue;
    if (selector.kind === "pinned") {
      if (id === selector.provider) out.push({ provider: id, model: selector.model });
    } else if (selector.kind === "named") {
      if (p.models.some((m) => m.id === selector.model)) {
        out.push({ provider: id, model: selector.model });
      }
    } else if (selector.kind === "class") {
      const m = p.models.find((x) => x.modelClass === selector.modelClass);
      if (m) out.push({ provider: id, model: m.id });
    }
  }
  return out;
}

export interface RouteInput {
  /** Caller's `model` field (concrete id, "provider/model", or "auto:<class>"). */
  model: string;
  quota: QuotaState;
  health: HealthState;
  config: Record<ProviderId, ProviderConfig>;
  /** Providers the caller has keys for (BYOK set or demo pool). */
  availableProviders: ProviderId[];
  /** Stable tiebreak when scores are equal (descending reliability). */
  reliabilityOrder?: ProviderId[];
}

/**
 * Rank providers for a request. Pure function of its inputs.
 */
export function route(input: RouteInput): RouteResult {
  const { quota, health, config, availableProviders } = input;
  const selector = parseModelSelector(input.model, config);
  if (selector.kind === "unknown") return { ok: false, reason: "unknown_model" };

  const eligible = eligibleProviders(selector, config, availableProviders);
  if (eligible.length === 0) return { ok: false, reason: "unsupported" };

  const order = input.reliabilityOrder ?? availableProviders;
  const candidates: RouteCandidate[] = [];
  /** Soonest quota reset among providers excluded purely for quota reasons. */
  let soonestResetMs = Infinity;

  for (const { provider, model } of eligible) {
    const limits = config[provider].limits;
    const q = quota[provider];
    const rpmUsed = q?.rpmUsed ?? 0;
    const rpdUsed = q?.rpdUsed ?? 0;
    const tpmUsed = q?.tpmUsed ?? 0;
    const rpmResetMs = q?.rpmResetMs ?? 60_000;
    const rpdResetMs = q?.rpdResetMs ?? 24 * 60 * 60 * 1000;

    if (q?.exhaustedForMs !== undefined) {
      soonestResetMs = Math.min(soonestResetMs, q.exhaustedForMs);
      continue;
    }

    const rpmFrac = (limits.rpm - rpmUsed) / limits.rpm;
    const rpdFrac = (limits.rpd - rpdUsed) / limits.rpd;
    const tpmFrac = (limits.tpm - tpmUsed) / limits.tpm;

    if (rpmFrac <= 0 || tpmFrac <= 0) {
      soonestResetMs = Math.min(soonestResetMs, rpmResetMs);
      continue;
    }
    if (rpdFrac <= 0) {
      soonestResetMs = Math.min(soonestResetMs, rpdResetMs);
      continue;
    }

    const headroom = Math.min(rpmFrac, rpdFrac, tpmFrac, 1);
    const score = headroom * 1 /* modelFit: eligible ⇒ exact class/id match */ *
      healthScore(health, provider);
    candidates.push({ provider, model, score });
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "exhausted",
      retryAfterMs: Number.isFinite(soonestResetMs) ? soonestResetMs : 60_000,
    };
  }

  const rank = (p: ProviderId) => {
    const i = order.indexOf(p);
    return i === -1 ? order.length : i;
  };
  candidates.sort((a, b) => b.score - a.score || rank(a.provider) - rank(b.provider));
  return { ok: true, candidates };
}
