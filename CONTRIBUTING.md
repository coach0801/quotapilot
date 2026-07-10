# Contributing to QuotaPilot

Thanks for helping keep the free-LLM map alive! The most valuable
contributions are **provider drift reports and fixes** — free tiers change
without notice.

## Quick start

```bash
npm ci
npm run test        # unit + contract tests, no network needed
npm run typecheck
npm run lint
```

No env vars are required for development: the gateway falls back to an
in-memory Redis and skips DB logging when `DATABASE_URL`/Upstash env are
absent.

## Common contributions

### A provider changed its limits or models
1. Update the defaults in `config/providers.ts` (and the verification date
   in its header comment).
2. If response headers changed, update that adapter's
   `parseRateLimitHeaders` and the fixture in `tests/contract/fixtures/`.

### Adding a provider
1. Add its config to `config/providers.ts` and its id to `PROVIDER_IDS`
   in `core/types.ts`.
2. If it speaks the OpenAI dialect, instantiate
   `createOpenAiCompatAdapter` (see `adapters/groq.ts`); otherwise write a
   custom adapter implementing `ProviderAdapter` (see `adapters/gemini.ts`).
3. Register it in `adapters/index.ts`, add a fixture + contract test, add
   a demo-key env var, done — routing/failover/status board pick it up
   automatically.

## Rules

- `core/` stays pure — no I/O, everything injected. CI enforces ≥80%
  coverage there.
- Privacy is non-negotiable: no prompts, keys, or raw IPs may ever be
  written to any log or table. PRs are reviewed for this specifically.
- Every PR needs green: lint, typecheck, tests, build.
