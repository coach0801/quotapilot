/**
 * /docs — quickstart (curl, TypeScript, Python), BYOK guide, self-host guide.
 */

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-xs text-zinc-300">
      {children}
    </pre>
  );
}

const CURL = `curl https://quotapilot.vercel.app/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H 'x-qp-keys: {"groq":"gsk_YOUR_KEY","gemini":"YOUR_KEY"}' \\
  -d '{
    "model": "auto:fast",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`;

const TS = `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://quotapilot.vercel.app/v1",
  apiKey: "unused", // QuotaPilot ignores it — auth is your provider keys
  defaultHeaders: {
    "x-qp-keys": JSON.stringify({ groq: process.env.GROQ_KEY }),
  },
});

const res = await client.chat.completions.create({
  model: "auto:strong",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(res.choices[0].message.content);
// Which provider served it?  res headers: x-qp-provider, x-qp-remaining`;

const PY = `from openai import OpenAI
import json, os

client = OpenAI(
    base_url="https://quotapilot.vercel.app/v1",
    api_key="unused",
    default_headers={"x-qp-keys": json.dumps({"groq": os.environ["GROQ_KEY"]})},
)

res = client.chat.completions.create(
    model="auto:fast",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
)
for chunk in res:
    print(chunk.choices[0].delta.content or "", end="")`;

const ENV_VARS: Array<[string, string]> = [
  ["DATABASE_URL", "Neon Postgres connection string"],
  ["UPSTASH_REDIS_REST_URL", "Upstash Redis REST URL"],
  ["UPSTASH_REDIS_REST_TOKEN", "Upstash Redis REST token"],
  ["DEMO_GROQ_KEY", "Demo-pool Groq key (playground)"],
  ["DEMO_GEMINI_KEY", "Demo-pool Google AI Studio key"],
  ["DEMO_MISTRAL_KEY", "Demo-pool Mistral key"],
  ["DEMO_OPENROUTER_KEY", "Demo-pool OpenRouter key"],
  ["DEMO_GITHUB_TOKEN", "Demo-pool GitHub PAT (models scope)"],
  ["REVALIDATE_SECRET", "Shared secret for POST /api/revalidate"],
];

export default function Docs() {
  return (
    <div className="prose-invert max-w-none space-y-10">
      <section className="space-y-3">
        <h1 className="text-2xl font-semibold">Documentation</h1>
        <p className="text-zinc-400">
          QuotaPilot exposes an OpenAI-compatible{" "}
          <code>POST /v1/chat/completions</code> (streaming and non-streaming).
          Point any OpenAI SDK at it by changing only the <code>baseURL</code>.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Models</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-400">
          <li>
            <code>auto:fast</code> / <code>auto:strong</code> /{" "}
            <code>auto:reasoning</code> — the router picks the provider with the
            most quota headroom and fails over across equivalents.
          </li>
          <li>
            <code>groq/llama-3.3-70b-versatile</code> — pin a provider + model
            (no cross-provider failover).
          </li>
          <li>
            A bare catalog id (e.g. <code>mistral-small-latest</code>) — any
            provider that serves it.
          </li>
        </ul>
        <p className="text-sm text-zinc-400">
          Every response carries <code>x-qp-provider</code>,{" "}
          <code>x-qp-fallback-depth</code> and <code>x-qp-remaining</code>{" "}
          (JSON of requests left per provider today).
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Quickstart — curl</h2>
        <Code>{CURL}</Code>
        <h2 className="text-lg font-semibold">Quickstart — TypeScript</h2>
        <Code>{TS}</Code>
        <h2 className="text-lg font-semibold">Quickstart — Python</h2>
        <Code>{PY}</Code>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">BYOK — bring your own keys</h2>
        <p className="text-sm text-zinc-400">
          QuotaPilot is a router, not a key vault. Get free keys from each
          provider console (Groq, Google AI Studio, Mistral La Plateforme,
          OpenRouter, GitHub PAT with models scope) and pass any subset in the{" "}
          <code>x-qp-keys</code> header. Keys are used for the single upstream
          call and discarded; only a SHA-256 hash is used as the Redis quota
          counter key. The playground stores keys in your browser&apos;s
          localStorage only.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Self-host</h2>
        <p className="text-sm text-zinc-400">
          Fork the repo, create free Neon + Upstash instances, then:
        </p>
        <a
          href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fcoach0801%2Fquotapilot"
          className="inline-block rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-white"
        >
          ▲ Deploy to Vercel
        </a>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-zinc-400">
              <th className="py-2 pr-4 font-medium">Env var</th>
              <th className="py-2 font-medium">Purpose</th>
            </tr>
          </thead>
          <tbody>
            {ENV_VARS.map(([name, purpose]) => (
              <tr key={name} className="border-b border-zinc-800/50">
                <td className="py-2 pr-4">
                  <code className="text-emerald-400">{name}</code>
                </td>
                <td className="py-2 text-zinc-400">{purpose}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-sm text-zinc-400">
          Set the same secrets in GitHub Actions for the hourly probe and daily
          rollup workflows. Apply the schema with{" "}
          <code>npx drizzle-kit push</code>. Without Redis/Postgres configured,
          the gateway still works — counters fall back to in-memory (per
          instance) and logging is skipped.
        </p>
      </section>
    </div>
  );
}
