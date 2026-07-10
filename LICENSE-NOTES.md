# License notes

QuotaPilot is MIT-licensed and **non-commercial by deployment policy**:

- The hosted instance runs on **Vercel Hobby**, whose terms require
  non-commercial use. The hosted product is therefore free, carries no
  billing, and sells nothing (spec §1, §12).
- The source is free to self-host. If you deploy it commercially, use a
  Vercel plan (or other host) whose terms permit that.
- Upstream free-tier LLM providers have their own terms — notably
  per-model commercial caveats on Mistral's free tier and OpenRouter's
  `:free` model policies. Verify them before commercial self-hosting.

Privacy commitments (enforced in code, see `db/schema.ts` and the gateway):

- No prompt or response bodies are ever stored.
- Provider keys are never persisted; only SHA-256 hashes are used as Redis
  counter keys.
- No raw IPs are stored — the playground limiter keys on a SHA-256 hash
  with a daily TTL.
