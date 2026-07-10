# QuotaPilot — Development Specification
### Rate-limit-aware gateway + live status board for free-tier LLM APIs

**Document owner:** Jovan · **Version:** 1.0 · **Date:** July 10, 2026
**Audience:** Development Team A — this document is self-contained; no other document is required.

---

## 1. Product Overview

**One-liner:** *"One endpoint for every free LLM API — with automatic failover, quota tracking, and a live status board."*

QuotaPilot is an open-source, OpenAI-compatible gateway that routes chat-completion requests across the free tiers of multiple LLM providers (Groq, Google Gemini, Mistral, OpenRouter, GitHub Models). It tracks each provider's rate limits in real time, routes every request to the provider with the most headroom, fails over automatically on errors, and publishes a public live status board of the free-LLM ecosystem.

**Why it will gain recognition:** the free-LLM-tier landscape is fragmented and volatile (providers change limits and model catalogs without notice). Developers actively search for "free LLM API" comparisons, but all existing resources are static blog posts that go stale. A live, self-updating tool wins that audience. The target users are developers on GitHub — the exact population that stars repositories.

**Hard constraints:**
- 100% free services: Vercel Hobby, Neon Postgres, Upstash Redis, free LLM tiers only.
- Deployed on Vercel; source public on GitHub (MIT license).
- Non-commercial (Vercel Hobby requirement) — free and open-source product.

## 2. Scope

### 2.1 MVP (must ship)
1. OpenAI-compatible endpoint `POST /v1/chat/completions` (streaming + non-streaming).
2. BYOK (Bring Your Own Key): callers pass their own provider keys; server never persists them.
3. Rate-limit-aware routing across ≥5 providers with automatic failover.
4. Public live status board (availability, latency, current limits per provider), auto-updated hourly.
5. Quota dashboard: per-session usage burn-down ("~340 Groq requests left today").
6. Web playground with per-IP demo limits (5 requests/day) on pooled demo keys.

### 2.2 V2 (after launch — do not build in MVP)
- Semantic response caching (Gemini free embeddings + similarity threshold).
- Weekly automated "free model leaderboard" (same prompts across providers, published page).
- `npm` SDK package (`quotapilot` client).

### 2.3 Out of scope
- Billing, accounts with passwords, fine-tuning, image models, self-serve key storage on server.

## 3. Tech Stack & Free Services (verified July 2026 — re-verify at kickoff)

| Layer | Choice | Free-tier limits that shape design |
|---|---|---|
| Framework | Next.js 15+ (App Router), TypeScript strict | — |
| Hosting | Vercel Hobby | 1M function invocations/mo, 4h active CPU/mo, **60s function timeout**, 100 GB bandwidth. Non-commercial only. Cron: max 2 jobs, 1×/day → use GitHub Actions for hourly probes |
| UI | Tailwind CSS + shadcn/ui + Recharts | — |
| DB | Neon Postgres (+ Drizzle ORM) | 0.5 GB, 100 CU-hrs/mo, scale-to-zero (no pause problem) |
| Cache/counters | Upstash Redis | Free tier; used for quota counters, response cache, per-IP demo limits |
| CI + probes | GitHub Actions | Unlimited minutes on public repos — **this is our hourly cron engine** |
| Validation | Zod on every external boundary | — |

### 3.1 Provider matrix (the adapters to build)

| Provider | Free models | Free limits (July 2026) | Notes |
|---|---|---|---|
| Groq | llama-3.3-70b-versatile, llama-4-scout, qwen3-32b, gpt-oss-120b/20b, whisper | 30 RPM, ~14,400 req/day, 6,000 TPM (small models) | Fastest; commercial OK; no card |
| Google Gemini (AI Studio) | gemini-flash | 5–15 RPM, 20–1,500 req/day per model | Also free embeddings API |
| Mistral | full catalog incl. devstral, magistral | ~50,000 TPM, ~1B tokens/mo | Per-model commercial caveats |
| OpenRouter | 20+ `:free` models | 20 RPM, 50 req/day (1,000/day after one-time $10 top-up) | Multi-provider |
| GitHub Models | gpt-4o, claude-3.5-sonnet, llama, phi | 15 RPM, 150–1,000 req/day | Free with GitHub account |
| Cerebras (optional 6th) | gpt-oss-120b, glm-4.7 | ~30,000 TPM | ⚠️ Catalog volatile — build adapter last |

**Design rule:** limits above are DEFAULTS in a config file, not hard-coded — each provider adapter must also parse rate-limit response headers when available and update live counters.

## 4. Architecture

```
Caller (openai SDK w/ baseURL override, or playground UI)
   │  headers: x-qp-keys: {groq: "...", gemini: "..."} (BYOK, optional)
   ▼
Vercel Edge Function  /v1/chat/completions
   1. Zod-validate request (OpenAI schema subset)
   2. Resolve key set: BYOK keys ∪ demo pool (if playground, check per-IP limit)
   3. Ask Router for best provider
   ▼
Router core (pure TypeScript module — fully unit-testable)
   score(provider) = headroom(RPM,RPD,TPM from Redis)
                   × modelFit(requested model/class)
                   × healthScore(recent error rate, p95 latency)
   ▼
Provider adapter (common interface) → upstream API
   on 429 → mark exhausted in Redis, re-route next provider
   on 5xx → retry ×2 exponential backoff, then re-route
   on 400 → fail fast to caller (their request is malformed)
   ▼
Response → normalize to OpenAI format → stream to caller
   └→ async: log latency/tokens to Neon (fire-and-forget)

GitHub Actions (hourly probe workflow)
   → tiny test call to each provider (demo keys)
   → write availability/latency/limit snapshot to Neon
   → POST Vercel revalidate hook → status board ISR refresh
```

### 4.1 Provider adapter contract (all adapters implement exactly this)

```ts
interface ProviderAdapter {
  id: ProviderId;                          // 'groq' | 'gemini' | ...
  models(): ModelInfo[];                   // from config, incl. modelClass: 'fast'|'strong'|'reasoning'
  chat(req: NormalizedChatRequest, key: string, signal: AbortSignal):
    Promise<NormalizedChatResponse | ReadableStream<NormalizedChunk>>;
  parseRateLimitHeaders(h: Headers): RateLimitSnapshot | null;
  classifyError(e: unknown): 'rate_limited' | 'server' | 'client' | 'auth';
}
```

### 4.2 Model classes
Callers may request a concrete model (`groq/llama-3.3-70b`) or a class (`auto:fast`, `auto:strong`, `auto:reasoning`). Classes are what make failover meaningful — the router substitutes an equivalent-class model on another provider.

## 5. Data Model (Neon Postgres, Drizzle)

```
providers_snapshots  (id, provider, ts, ok boolean, latency_ms, http_status,
                      advertised_limits jsonb, note text)         -- from hourly probes
request_logs         (id, ts, provider, model, model_class, latency_ms,
                      tokens_in, tokens_out, outcome, fallback_depth int)
                      -- NO prompt/response bodies, NO keys, NO IPs (privacy by design)
daily_rollups        (day, provider, requests, errors, p50_ms, p95_ms)  -- cron rollup
```

Redis keys (Upstash):
```
qp:quota:{keyHash}:{provider}:rpm   — sliding window counter, 60s TTL
qp:quota:{keyHash}:{provider}:rpd   — daily counter, midnight-UTC TTL
qp:health:{provider}                — rolling error-rate + latency EWMA
qp:demo:{ipHash}:daily              — playground limiter (5/day)
qp:cache:{sha256(model+messages)}   — response cache, 1h TTL (exact-match MVP)
```
`keyHash` = SHA-256 of the caller's provider key — lets us track quota per key without storing the key.

## 6. API Design

### `POST /v1/chat/completions`
OpenAI-compatible subset: `model`, `messages`, `temperature`, `max_tokens`, `stream`, `stop`. Extra response header: `x-qp-provider`, `x-qp-fallback-depth`, `x-qp-remaining: {"groq":{"rpd":339},...}`.

### `GET /api/status` — JSON of latest provider snapshots (public, cached 5 min).
### `GET /api/quota` — remaining quota for the caller's key set (BYOK headers required).
### Pages: `/` (landing + live status board, ISR 1h), `/playground`, `/dashboard` (client-side, reads /api/quota), `/docs`.

## 7. Repository Structure

```
quotapilot/
├─ app/                      # Next.js App Router (pages + api routes)
│  ├─ v1/chat/completions/route.ts     # edge runtime
│  ├─ api/{status,quota,revalidate}/route.ts
│  └─ (site)/{page.tsx, playground/, dashboard/, docs/}
├─ core/
│  ├─ router.ts              # pure scoring/selection logic (no I/O)
│  ├─ failover.ts            # retry taxonomy state machine
│  ├─ quota.ts               # Redis counter read/write
│  └─ normalize.ts           # OpenAI-format request/response mapping
├─ adapters/{groq,gemini,mistral,openrouter,github-models}.ts
├─ config/providers.ts       # default limits, model catalog, model classes
├─ db/{schema.ts, queries.ts}
├─ scripts/probe.ts          # run by GitHub Actions hourly
├─ tests/{unit/, contract/, e2e/}
└─ .github/workflows/{ci.yml, probe.yml, rollup.yml}
```

## 8. Detailed Development Plan — step by step

> One senior developer, 4 weeks. Steps are ordered; each ends in a mergeable PR with tests. Do not reorder Phases 1–3.

### Phase 0 — Accounts & keys (Day 1, morning)
1. Create GitHub org/repo `quotapilot` (public, MIT license, README stub).
2. Sign up (no credit card where possible) and generate keys: Groq console, Google AI Studio, Mistral La Plateforme, OpenRouter, GitHub PAT (models scope). These become the **demo pool** keys.
3. Create Neon project (region: `eu-central` or `us-east` — match Vercel region) and Upstash Redis database.
4. Create Vercel project linked to the repo. Set env vars in Vercel AND GitHub Actions secrets:
   `DATABASE_URL, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, DEMO_GROQ_KEY, DEMO_GEMINI_KEY, DEMO_MISTRAL_KEY, DEMO_OPENROUTER_KEY, DEMO_GITHUB_TOKEN, REVALIDATE_SECRET`.
5. ⚠️ Verify every limit in §3.1 against provider docs **today**; update `config/providers.ts` defaults accordingly and record the verification date in the file header.

### Phase 1 — Skeleton & CI (Days 1–2)
6. `npx create-next-app` (TypeScript, App Router, Tailwind); add shadcn/ui, Drizzle, Zod, Upstash SDK.
7. Drizzle schema (§5) + `drizzle-kit push` to Neon; commit migration files.
8. CI workflow: lint (eslint), typecheck, `vitest run`, build — required on PRs.
9. Deploy "hello" landing page to Vercel — deployment pipeline proven before any feature code.

### Phase 2 — Adapters (Days 3–6) ← highest-risk phase, do early
10. Define `ProviderAdapter` interface + `NormalizedChatRequest/Response/Chunk` types + Zod schemas.
11. Implement adapters in this order: **Groq → Gemini → Mistral → OpenRouter → GitHub Models** (descending reliability). For each: non-streaming, then streaming (SSE → normalized chunks), then `classifyError`, then `parseRateLimitHeaders`.
12. **Contract tests** (`tests/contract/`): one live smoke test per adapter (runs in CI nightly, not on PRs) + recorded-fixture tests (run on every PR). Fixtures: capture real responses once, commit sanitized copies.
13. Exit criteria: same prompt returns a normalized response from all 5 adapters; streaming works for all; error taxonomy verified by forcing a 429 (tight loop on smallest model) and a 401 (bad key).

### Phase 3 — Router + quota core (Days 7–9)
14. `core/quota.ts`: sliding-window RPM + daily RPD counters in Redis (atomic Lua/`INCR`+TTL); read function returns headroom fractions.
15. `core/router.ts`: pure function `(request, quotaState, healthState, config) → rankedProviders[]`. **No I/O in this module** — everything injected, so unit tests cover: headroom exhaustion, model-class substitution, health degradation, all-exhausted case (return 429 with `Retry-After` = soonest reset).
16. `core/failover.ts`: state machine — try ranked list in order; per attempt apply the error taxonomy (429 → next provider + mark exhausted; 5xx → backoff 500ms/2s then next; 400/auth → stop, surface to caller). Max fallback depth 3. Unit-test every transition.
17. Target: ≥80% coverage on `core/` (enforced in CI via vitest coverage threshold).

### Phase 4 — Gateway endpoint (Days 10–12)
18. `/v1/chat/completions` edge route: Zod-validate → resolve keys (parse `x-qp-keys` header; if absent AND request from playground origin, use demo pool + per-IP Redis limiter; else 401 with helpful message) → router → adapter → stream response. Set `x-qp-*` response headers.
19. **60s timeout guard:** `AbortSignal.timeout(50_000)` per upstream attempt; if a stream is already flowing, pass it through (streams don't count against function CPU the same way — verify in staging).
20. Fire-and-forget request logging to Neon (`waitUntil`), never blocking the response. Assert in code review: no key, prompt, or IP is ever written.
21. E2E test: the **official `openai` npm client** pointed at localhost with only `baseURL` changed completes a chat + a streamed chat. This test is the compatibility contract.

### Phase 5 — Status board + probes (Days 13–15)
22. `scripts/probe.ts`: for each provider, one minimal completion ("ping") with demo key → write snapshot row (ok, latency, status, limits from headers/config). Handle failure as data, not as script crash.
23. `.github/workflows/probe.yml`: hourly schedule, runs probe script, then hits `POST /api/revalidate?secret=…`.
24. Status board on `/`: provider cards (up/down, p95 latency sparkline — Recharts, current limits, "last checked"), 30-day uptime bar. ISR, revalidate 1h + on-demand.
25. `rollup.yml` daily workflow: aggregate `request_logs` → `daily_rollups`, delete raw logs >30 days (keeps DB under 0.5 GB).

### Phase 6 — Playground + dashboard + docs (Days 16–18)
26. Playground: model-class picker, chat UI, streams via the real gateway; shows which provider served each reply and fallback depth (this visual is the demo GIF). Per-IP counter surfaced ("demo: 3/5 left today — paste your own free keys for unlimited").
27. BYOK key manager: client-side only (localStorage), keys attached as headers per request; a visible note + link to code proving keys never persist server-side.
28. Dashboard: burn-down bars per provider from `/api/quota`.
29. `/docs`: quickstart (3 languages: curl, TS, Python), BYOK guide, self-host guide ("Deploy to Vercel" button + env var table).

### Phase 7 — Hardening & launch prep (Days 19–20)
30. Load sanity: script fires 50 concurrent playground requests → verify limiter, no key leakage in logs, CPU usage in Vercel dashboard within budget.
31. Kill-switch test (acceptance criterion): revoke the demo Groq key in staging config → all traffic transparently fails over; capture this as a test + a GIF for the README.
32. README final: hero GIF (playground failover), architecture diagram, status-board screenshot, "built entirely on free tiers" section with the budget math, Deploy button, CONTRIBUTING.md, issue templates.
33. Run the full acceptance checklist (§10). Tag `v0.1.0`.

## 9. Testing Strategy

| Layer | Tool | Gate |
|---|---|---|
| Unit (`core/`) | Vitest | ≥80% coverage, every failover transition |
| Adapter contract | Vitest + recorded fixtures | On every PR |
| Adapter live smoke | Vitest (real APIs, demo keys) | Nightly workflow only |
| E2E | Playwright + official `openai` client | On every PR (against preview deploy) |
| Probe pipeline | Assert snapshot rows appear after workflow run | Nightly |

## 10. Acceptance Criteria (definition of done)

- [ ] Official `openai` SDK works by changing only `baseURL` (streaming + non-streaming) — proven by CI test.
- [ ] Revoking any single provider key produces zero caller-visible failures (test + README GIF).
- [ ] Status board runs unattended for 14 consecutive days with hourly updates.
- [ ] p95 gateway overhead (request-in → upstream-call-out) < 150 ms, measured and published in README.
- [ ] ≥80% unit coverage on `core/`; adapter contract tests green for all 5 providers.
- [ ] Zero prompts, keys, or raw IPs in any database or log (code-review sign-off + grep audit).
- [ ] Total infra bill: **$0.00** (screenshot the Vercel/Neon/Upstash usage pages in the README).

## 11. Launch Checklist (after acceptance)

1. Show HN: "QuotaPilot – one endpoint for every free LLM API, with live failover" (link the live status board — it's the hook).
2. Post to r/LocalLLaMA and r/webdev; dev.to article "How I built a $0 LLM gateway on free tiers" (the cost architecture is the viral angle).
3. Submit to awesome-llm / awesome-ai-agents lists.
4. Add the status-board page URL to the repo description (GitHub SEO for "free LLM API").

## 12. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Provider changes limits/models mid-development (proven: Cerebras) | Limits live in config + header parsing; probes detect drift within 1h; adapters isolated so one break ≠ product break |
| Demo-pool quota abuse | Per-IP Redis limit, playground-origin check, BYOK as the promoted path |
| 60s Vercel timeout on slow providers | 50s abort per attempt; streaming passthrough; fast providers ranked first |
| Neon 0.5 GB fills up | 30-day raw-log retention + daily rollups (Step 25) |
| Vercel Hobby non-commercial term | Product stays free/OSS; document in LICENSE-NOTES.md |

---
*Free-tier figures verified July 10, 2026. Re-verify at kickoff (Phase 0, step 5) — free tiers change without notice.*
