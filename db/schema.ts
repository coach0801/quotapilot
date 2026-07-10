/**
 * Neon Postgres schema (spec §5).
 *
 * Privacy by design: request_logs stores NO prompt/response bodies,
 * NO keys, NO IPs — only routing metadata and latency/token counts.
 */

import {
  boolean,
  date,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** Hourly probe results (written by scripts/probe.ts via GitHub Actions). */
export const providersSnapshots = pgTable("providers_snapshots", {
  id: serial("id").primaryKey(),
  provider: text("provider").notNull(),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  ok: boolean("ok").notNull(),
  latencyMs: integer("latency_ms"),
  httpStatus: integer("http_status"),
  advertisedLimits: jsonb("advertised_limits"),
  note: text("note"),
});

/** Per-request routing metadata (fire-and-forget from the gateway). */
export const requestLogs = pgTable("request_logs", {
  id: serial("id").primaryKey(),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  modelClass: text("model_class"),
  latencyMs: integer("latency_ms"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  outcome: text("outcome").notNull(),
  fallbackDepth: integer("fallback_depth").notNull().default(0),
});

/** Daily aggregates (rollup cron) — keeps the DB under Neon's 0.5 GB. */
export const dailyRollups = pgTable(
  "daily_rollups",
  {
    day: date("day").notNull(),
    provider: text("provider").notNull(),
    requests: integer("requests").notNull(),
    errors: integer("errors").notNull(),
    p50Ms: integer("p50_ms"),
    p95Ms: integer("p95_ms"),
  },
  (t) => [primaryKey({ columns: [t.day, t.provider] })],
);

export type ProviderSnapshot = typeof providersSnapshots.$inferSelect;
export type NewProviderSnapshot = typeof providersSnapshots.$inferInsert;
export type RequestLog = typeof requestLogs.$inferSelect;
export type NewRequestLog = typeof requestLogs.$inferInsert;
export type DailyRollup = typeof dailyRollups.$inferSelect;
