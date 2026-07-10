# ◈ QuotaPilot

**One endpoint for every free LLM API — with automatic failover, quota tracking, and a live status board.**

QuotaPilot is an open-source, OpenAI-compatible gateway that routes chat
completions across the free tiers of **Groq, Google Gemini, Mistral,
OpenRouter and GitHub Models**. It tracks each provider's rate limits in
real time, sends every request to the provider with the most headroom,
fails over automatically on errors, and publishes a public, self-updating
status board of the free-LLM ecosystem.

> The free-LLM landscape is fragmented and volatile — providers change
> limits and model catalogs without notice. Static "free LLM API" blog
> posts go stale in weeks. QuotaPilot is the live version.

## Use it in 30 seconds

Point the official OpenAI SDK at QuotaPilot — change **only the `baseURL`**
and pass your own free provider keys (any subset) in one header:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://quotapilot.vercel.app/v1",
  apiKey: "unused", // auth is your provider keys, passed per request
  defaultHeaders: {
    "x-qp-keys": JSON.stringify({ groq: "gsk_...", gemini: "AIza..." }),
  },
});

const res = await client.chat.completions.create({
  model: "auto:fast", // or auto:strong, auto:reasoning, or a concrete id
  messages: [{ role: "user", content: "Hello!" }],
});
```

Every response tells you what happened:

| Header | Meaning |
|---|---|
| `x-qp-provider` | which provider actually served the request |
| `x-qp-fallback-depth` | how many providers were tried before success |
| `x-qp-remaining` | JSON of requests left per provider today |

**BYOK, zero trust required:** keys are used for the single upstream call
and discarded. Only their SHA-256 hash exists server-side (as a Redis
counter key). No prompts, no keys, no IPs are ever stored — the database
schema has no columns for them.

## How it works

```
Caller (openai SDK w/ baseURL override, or playground UI)
   │  x-qp-keys: {"groq":"...","gemini":"..."}   (BYOK, never persisted)
   ▼
Vercel Edge Function  /v1/chat/completions
   1. Zod-validate (OpenAI schema subset)
   2. Resolve key set: BYOK ∪ demo pool (playground, 5/day per IP)
   3. Router: score = headroom(RPM/RPD/TPM) × modelFit × health
   ▼
Failover state machine over the ranked providers
   429 → mark exhausted in Redis, next provider
   5xx → retry ×2 (500ms/2s backoff), then next provider
   400/401 → fail fast to caller
   ▼
Provider adapter → normalize to OpenAI format → stream back
   └→ async: latency/token metadata to Neon (fire-and-forget)

GitHub Actions (hourly)
   → probe every provider → snapshot to Neon → revalidate status board
```

Model classes make failover meaningful: request `auto:strong` and the
router substitutes an equivalent-class model on another provider when the
first one is exhausted (`llama-3.3-70b` on Groq ⇄ `gemini-2.5-flash` ⇄
`mistral-medium` …). Pin `groq/llama-3.3-70b-versatile` when you need one
exact model.

## Built entirely on free tiers — the $0 architecture

| Layer | Service | Free tier that shapes the design |
|---|---|---|
| Hosting | Vercel Hobby | 1M invocations/mo, 60s timeout → 50s upstream abort + streaming passthrough |
| Database | Neon Postgres | 0.5 GB → 30-day raw-log retention + daily rollups |
| Counters | Upstash Redis | quota counters, health EWMA, demo limiter |
| Hourly cron | GitHub Actions | Vercel Hobby cron is 1×/day, so Actions is the probe engine |
| LLMs | 5 providers' free tiers | limits live in `config/providers.ts` + live header parsing |

## Run it yourself

```bash
git clone https://github.com/coach0801/quotapilot && cd quotapilot
npm ci
cp .env.example .env.local   # fill in Neon, Upstash, demo keys
npx drizzle-kit push          # create tables
npm run dev
```

Without `DATABASE_URL`/Redis env the gateway still works — counters fall
back to in-memory and logging is skipped — so `npm run dev` + your own
keys is enough to try it.

Deploy: click the button in [/docs](https://quotapilot.vercel.app/docs),
set the env vars from `.env.example` in Vercel and as GitHub Actions
secrets, and enable the `probe.yml` / `rollup.yml` workflows.

## Development

```bash
npm run test           # unit + adapter contract tests (fixtures, no network)
npm run test:coverage  # enforces ≥80% coverage on core/
npm run test:live      # real-API smoke tests (QP_LIVE=1 + demo keys)
npm run test:e2e       # official openai client vs a deploy (QP_E2E_BASE_URL)
npm run typecheck && npm run lint && npm run build
```

- `core/` is pure TypeScript with zero I/O — router scoring, failover
  state machine, quota math are all unit-tested deterministically.
- `adapters/` implement one shared contract (`ProviderAdapter`); contract
  tests run against committed, sanitized fixtures on every PR and against
  the real APIs nightly.
- The e2e suite is the compatibility contract: the **official `openai`
  client with only `baseURL` changed** must complete a chat and a streamed
  chat.

## License

[MIT](LICENSE). Hosted instance is non-commercial (Vercel Hobby terms) —
see [LICENSE-NOTES.md](LICENSE-NOTES.md).
