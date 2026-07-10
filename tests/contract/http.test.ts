import { describe, expect, it } from "vitest";

import {
  classifyHttpStatus,
  mapSseStream,
  parseCommonRateLimitHeaders,
  parseResetMs,
  sseDataStream,
} from "@/adapters/http";
import { collect } from "./helpers";

const NOW = 1_752_000_000_000;

function bodyFrom(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body!;
}

describe("parseResetMs", () => {
  it("parses Groq duration strings", () => {
    expect(parseResetMs("7.66s", NOW)).toBe(7660);
    expect(parseResetMs("2m59.56s", NOW)).toBe(179_560);
    expect(parseResetMs("1h2m", NOW)).toBe(3_720_000);
    expect(parseResetMs("500ms", NOW)).toBe(500);
  });

  it("parses relative seconds and epoch stamps", () => {
    expect(parseResetMs("30", NOW)).toBe(30_000);
    expect(parseResetMs(String(NOW + 45_000), NOW)).toBe(45_000); // epoch ms
    expect(parseResetMs(String((NOW + 60_000) / 1000), NOW)).toBe(60_000); // epoch s
  });

  it("returns undefined for junk", () => {
    expect(parseResetMs(null, NOW)).toBeUndefined();
    expect(parseResetMs("", NOW)).toBeUndefined();
    expect(parseResetMs("soon", NOW)).toBeUndefined();
  });
});

describe("classifyHttpStatus", () => {
  it("implements the retry taxonomy", () => {
    expect(classifyHttpStatus(429)).toBe("rate_limited");
    expect(classifyHttpStatus(401)).toBe("auth");
    expect(classifyHttpStatus(403)).toBe("auth");
    expect(classifyHttpStatus(500)).toBe("server");
    expect(classifyHttpStatus(400)).toBe("client");
    expect(classifyHttpStatus(404)).toBe("client");
  });
});

describe("parseCommonRateLimitHeaders", () => {
  it("returns null when no limit headers exist", () => {
    expect(parseCommonRateLimitHeaders(new Headers(), NOW)).toBeNull();
  });

  it("prefers -requests/-tokens variants over bare names", () => {
    const snap = parseCommonRateLimitHeaders(
      new Headers({
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-limit": "999",
        "x-ratelimit-remaining-tokens": "500",
      }),
      NOW,
    )!;
    expect(snap.limitRequests).toBe(100);
    expect(snap.remainingTokens).toBe(500);
  });
});

describe("sseDataStream / mapSseStream", () => {
  it("extracts data payloads across chunk boundaries and CRLF", async () => {
    const payloads = await collect(
      sseDataStream(bodyFrom('data: {"a":1}\r\n\r\ndata: {"b":2}\n\n')),
    );
    expect(payloads).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("stops at [DONE] and skips unparseable payloads", async () => {
    const stream = mapSseStream(
      bodyFrom(
        'data: {"v":1}\n\ndata: not-json\n\ndata: {"v":2}\n\ndata: [DONE]\n\ndata: {"v":3}\n\n',
      ),
      (p) => {
        try {
          return JSON.parse(p) as { v: number };
        } catch {
          return null;
        }
      },
    );
    expect(await collect(stream)).toEqual([{ v: 1 }, { v: 2 }]);
  });
});
