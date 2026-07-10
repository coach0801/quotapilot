"use client";

/**
 * Playground (spec §8 step 26–27): chat UI streaming through the real
 * gateway; shows which provider served each reply and the fallback depth.
 * BYOK keys live in localStorage ONLY and are attached as a header per
 * request — they never touch the server's storage.
 */

import { useEffect, useRef, useState } from "react";

import { useLocalKeys } from "@/lib/use-local-keys";

const PROVIDER_KEYS = [
  { id: "groq", label: "Groq", placeholder: "gsk_..." },
  { id: "gemini", label: "Google Gemini", placeholder: "AIza..." },
  { id: "mistral", label: "Mistral", placeholder: "..." },
  { id: "openrouter", label: "OpenRouter", placeholder: "sk-or-..." },
  { id: "github-models", label: "GitHub Models", placeholder: "github_pat_..." },
] as const;

const MODEL_CHOICES = [
  { value: "auto:fast", label: "auto:fast — cheapest fast model anywhere" },
  { value: "auto:strong", label: "auto:strong — best general model anywhere" },
  { value: "auto:reasoning", label: "auto:reasoning — thinking models" },
  { value: "groq/llama-3.3-70b-versatile", label: "groq/llama-3.3-70b-versatile (pinned)" },
  { value: "gemini/gemini-2.5-flash", label: "gemini/gemini-2.5-flash (pinned)" },
];

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  provider?: string;
  fallbackDepth?: string;
}

export default function Playground() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState(MODEL_CHOICES[0].value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [demoRemaining, setDemoRemaining] = useState<string | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { keys, activeKeys, setKey } = useLocalKeys();

  useEffect(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), [messages]);

  const hasByok = Object.keys(activeKeys).length > 0;

  async function send() {
    const prompt = input.trim();
    if (!prompt || busy) return;
    setError(null);
    setBusy(true);
    setInput("");

    const history = [...messages, { role: "user" as const, content: prompt }];
    setMessages([...history, { role: "assistant", content: "" }]);

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (hasByok) headers["x-qp-keys"] = JSON.stringify(activeKeys);

      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          stream: true,
          messages: history.map(({ role, content }) => ({ role, content })),
        }),
      });

      const demo = res.headers.get("x-qp-demo-remaining");
      if (demo !== null) setDemoRemaining(demo);

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          body?.error?.message ?? `Gateway returned HTTP ${res.status}`,
        );
      }

      const provider = res.headers.get("x-qp-provider") ?? undefined;
      const fallbackDepth = res.headers.get("x-qp-fallback-depth") ?? undefined;
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = { ...copy[copy.length - 1], provider, fallbackDepth };
        return copy;
      });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const delta: string =
              JSON.parse(payload).choices?.[0]?.delta?.content ?? "";
            if (delta) {
              setMessages((m) => {
                const copy = [...m];
                const last = copy[copy.length - 1];
                copy[copy.length - 1] = { ...last, content: last.content + delta };
                return copy;
              });
            }
          } catch {
            /* ignore malformed lines */
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMessages((m) => (m[m.length - 1]?.content === "" ? m.slice(0, -1) : m));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Playground</h1>
        <div className="flex items-center gap-3 text-sm">
          {!hasByok && (
            <span className="text-zinc-400">
              demo: {demoRemaining ?? "5"}/5 left today —{" "}
              <button
                onClick={() => setShowKeys(true)}
                className="text-emerald-400 hover:underline"
              >
                paste your own free keys
              </button>{" "}
              for unlimited
            </span>
          )}
          {hasByok && (
            <span className="text-emerald-400">
              using your keys ({Object.keys(activeKeys).join(", ")})
            </span>
          )}
          <button
            onClick={() => setShowKeys((v) => !v)}
            className="rounded border border-zinc-700 px-2 py-1 text-xs hover:border-zinc-500"
          >
            {showKeys ? "close keys" : "manage keys"}
          </button>
        </div>
      </div>

      {showKeys && (
        <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
          <p className="text-xs text-zinc-400">
            Keys are stored in <strong>your browser&apos;s localStorage only</strong>{" "}
            and sent as a per-request header. The server never persists them —{" "}
            <a
              href="https://github.com/coach0801/quotapilot/blob/main/app/v1/chat/completions/route.ts"
              className="text-emerald-400 hover:underline"
            >
              read the code
            </a>
            .
          </p>
          {PROVIDER_KEYS.map((p) => (
            <label key={p.id} className="flex items-center gap-3 text-sm">
              <span className="w-32 text-zinc-400">{p.label}</span>
              <input
                type="password"
                value={keys[p.id] ?? ""}
                placeholder={p.placeholder}
                onChange={(e) => setKey(p.id, e.target.value)}
                className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs"
              />
            </label>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3">
        <label className="text-sm text-zinc-400">Model</label>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
        >
          {MODEL_CHOICES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <div className="min-h-[320px] space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        {messages.length === 0 && (
          <p className="text-sm text-zinc-500">
            Ask anything. Watch the provider badge — kill one provider&apos;s
            quota and the next request fails over transparently.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : ""}>
            <div
              className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                m.role === "user"
                  ? "bg-emerald-500/15 text-emerald-100"
                  : "bg-zinc-800 text-zinc-100"
              }`}
            >
              {m.content || (busy && i === messages.length - 1 ? "…" : "")}
            </div>
            {m.role === "assistant" && m.provider && (
              <div className="mt-1 text-xs text-zinc-500">
                served by <span className="text-emerald-400">{m.provider}</span>
                {m.fallbackDepth && m.fallbackDepth !== "0" && (
                  <span className="text-amber-400">
                    {" "}
                    · failover depth {m.fallbackDepth}
                  </span>
                )}
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {error && (
        <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Say something…"
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={busy || input.trim() === ""}
          className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 disabled:opacity-50"
        >
          {busy ? "streaming…" : "Send"}
        </button>
      </form>
    </div>
  );
}
