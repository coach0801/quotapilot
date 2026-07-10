/**
 * Shared type vocabulary for QuotaPilot.
 *
 * Everything that crosses a module boundary (adapters, router, failover,
 * gateway) is typed here so `core/` stays free of I/O concerns.
 */

export const PROVIDER_IDS = [
  "groq",
  "gemini",
  "mistral",
  "openrouter",
  "github-models",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export type ModelClass = "fast" | "strong" | "reasoning";

export const MODEL_CLASSES: readonly ModelClass[] = [
  "fast",
  "strong",
  "reasoning",
];

export interface ModelInfo {
  /** Provider-native model id, e.g. "llama-3.3-70b-versatile". */
  id: string;
  modelClass: ModelClass;
  contextWindow?: number;
}

/** Requests per minute / requests per day / tokens per minute. */
export interface ProviderLimits {
  rpm: number;
  rpd: number;
  tpm: number;
}

export interface ProviderConfig {
  id: ProviderId;
  name: string;
  baseUrl: string;
  /** DEFAULT limits — live header parsing overrides these at runtime. */
  limits: ProviderLimits;
  models: ModelInfo[];
  /** Env var holding the demo-pool key for this provider. */
  demoKeyEnv: string;
}

// ---------------------------------------------------------------------------
// Normalized chat protocol (internal lingua franca between gateway & adapters)
// ---------------------------------------------------------------------------

export type ChatRole = "system" | "user" | "assistant";

export interface NormalizedMessage {
  role: ChatRole;
  content: string;
}

export interface NormalizedChatRequest {
  /** Model as the caller requested it (concrete id or "auto:<class>"). */
  model: string;
  messages: NormalizedMessage[];
  temperature?: number;
  maxTokens?: number;
  stream: boolean;
  stop?: string[];
}

export interface NormalizedUsage {
  promptTokens: number;
  completionTokens: number;
}

export type FinishReason = "stop" | "length" | "other";

export interface NormalizedChatResponse {
  id: string;
  /** Upstream model that actually served the request. */
  model: string;
  content: string;
  finishReason: FinishReason;
  usage?: NormalizedUsage;
  /** Live limits parsed from response headers, when the provider sends them. */
  rateLimit?: RateLimitSnapshot;
}

export interface NormalizedChunk {
  id: string;
  model: string;
  delta: string;
  finishReason?: FinishReason | null;
  usage?: NormalizedUsage;
  /** Set on the first chunk when response headers carried limit info. */
  rateLimit?: RateLimitSnapshot;
}

// ---------------------------------------------------------------------------
// Rate limits & errors
// ---------------------------------------------------------------------------

export interface RateLimitSnapshot {
  limitRequests?: number;
  remainingRequests?: number;
  limitTokens?: number;
  remainingTokens?: number;
  /** Milliseconds until the request-count window resets. */
  resetRequestsMs?: number;
  /** Milliseconds until the token-count window resets. */
  resetTokensMs?: number;
}

export type ErrorClass = "rate_limited" | "server" | "client" | "auth";

/** Thrown by adapters for non-2xx upstream responses. */
export class AdapterHttpError extends Error {
  readonly name = "AdapterHttpError";
  constructor(
    readonly provider: ProviderId,
    readonly status: number,
    readonly body: string,
    readonly retryAfterMs?: number,
  ) {
    super(`[${provider}] upstream HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------
// Provider adapter contract (§4.1 of the spec — all adapters implement this)
// ---------------------------------------------------------------------------

export interface ProviderAdapter {
  id: ProviderId;
  models(): ModelInfo[];
  chat(
    req: NormalizedChatRequest,
    key: string,
    signal: AbortSignal,
  ): Promise<NormalizedChatResponse | ReadableStream<NormalizedChunk>>;
  parseRateLimitHeaders(h: Headers): RateLimitSnapshot | null;
  classifyError(e: unknown): ErrorClass;
}

// ---------------------------------------------------------------------------
// Router inputs (injected — router itself performs no I/O)
// ---------------------------------------------------------------------------

export interface ProviderQuotaState {
  rpmUsed: number;
  rpdUsed: number;
  tpmUsed: number;
  /** ms until the RPM sliding window rolls over (≤ 60_000). */
  rpmResetMs: number;
  /** ms until midnight UTC. */
  rpdResetMs: number;
  /** Set when failover marked the provider exhausted (429 upstream). */
  exhaustedForMs?: number;
}

export type QuotaState = Partial<Record<ProviderId, ProviderQuotaState>>;

export interface ProviderHealthState {
  /** Rolling error-rate EWMA in [0, 1]. */
  errorRate: number;
  /** Rolling latency EWMA in ms. */
  latencyMs: number;
}

export type HealthState = Partial<Record<ProviderId, ProviderHealthState>>;
