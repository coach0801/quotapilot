import { vi, type MockInstance } from "vitest";

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

/** Build a text/event-stream Response from JSON payloads (OpenAI dialect). */
export function sseResponse(
  payloads: unknown[],
  init: { headers?: Record<string, string>; done?: boolean } = {},
): Response {
  const lines = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`);
  if (init.done !== false) lines.push("data: [DONE]\n\n");
  return new Response(lines.join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream", ...init.headers },
  });
}

export function mockFetch(response: Response): MockInstance {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(response);
}

export async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const out: T[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

export function lastFetchCall(spy: MockInstance): {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
} {
  const [url, init] = spy.mock.calls[spy.mock.calls.length - 1] as [
    string,
    RequestInit,
  ];
  return { url, init, body: JSON.parse(String(init.body)) };
}
