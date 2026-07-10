/**
 * All Neon queries live here. Callers pass a Db from getDb(); every
 * function no-ops (or returns empty data) when db is null so the product
 * keeps serving traffic even if the database is unreachable.
 */

import { and, desc, gte, lt, sql } from "drizzle-orm";

import type { Db } from "./client";
import {
  dailyRollups,
  providersSnapshots,
  requestLogs,
  type DailyRollup,
  type NewProviderSnapshot,
  type NewRequestLog,
  type ProviderSnapshot,
} from "./schema";

// ---------------------------------------------------------------------------
// Probe snapshots
// ---------------------------------------------------------------------------

export async function insertSnapshot(
  db: Db | null,
  row: NewProviderSnapshot,
): Promise<void> {
  if (!db) return;
  await db.insert(providersSnapshots).values(row);
}

/** Latest snapshot per provider (status board headline + /api/status). */
export async function latestSnapshots(db: Db | null): Promise<ProviderSnapshot[]> {
  if (!db) return [];
  return db
    .selectDistinctOn([providersSnapshots.provider])
    .from(providersSnapshots)
    .orderBy(providersSnapshots.provider, desc(providersSnapshots.ts));
}

/** Snapshots since `sinceHours` ago (latency sparklines). */
export async function recentSnapshots(
  db: Db | null,
  sinceHours: number,
): Promise<ProviderSnapshot[]> {
  if (!db) return [];
  const since = new Date(Date.now() - sinceHours * 3_600_000);
  return db
    .select()
    .from(providersSnapshots)
    .where(gte(providersSnapshots.ts, since))
    .orderBy(providersSnapshots.ts);
}

export interface UptimeDay {
  provider: string;
  day: string;
  total: number;
  up: number;
}

/** Per-provider daily up/total probe counts for the 30-day uptime bar. */
export async function uptimeByDay(
  db: Db | null,
  days: number = 30,
): Promise<UptimeDay[]> {
  if (!db) return [];
  const since = new Date(Date.now() - days * 24 * 3_600_000);
  const rows = await db
    .select({
      provider: providersSnapshots.provider,
      day: sql<string>`(${providersSnapshots.ts} at time zone 'utc')::date::text`,
      total: sql<number>`count(*)::int`,
      up: sql<number>`count(*) filter (where ${providersSnapshots.ok})::int`,
    })
    .from(providersSnapshots)
    .where(gte(providersSnapshots.ts, since))
    .groupBy(
      providersSnapshots.provider,
      sql`(${providersSnapshots.ts} at time zone 'utc')::date`,
    )
    .orderBy(sql`2`);
  return rows;
}

// ---------------------------------------------------------------------------
// Request logs (privacy rule: no prompts, no keys, no IPs — enforced by the
// schema having no columns for them)
// ---------------------------------------------------------------------------

export async function logRequest(
  db: Db | null,
  row: NewRequestLog,
): Promise<void> {
  if (!db) return;
  await db.insert(requestLogs).values(row);
}

// ---------------------------------------------------------------------------
// Daily rollups + retention (spec §8 step 25)
// ---------------------------------------------------------------------------

/**
 * Aggregate one UTC day of request_logs into daily_rollups (idempotent),
 * then delete raw logs older than `retentionDays`.
 */
export async function rollupDay(
  db: Db | null,
  dayIso: string,
  retentionDays: number = 30,
): Promise<void> {
  if (!db) return;
  const dayStart = new Date(`${dayIso}T00:00:00Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3_600_000);

  const aggregates = await db
    .select({
      provider: requestLogs.provider,
      requests: sql<number>`count(*)::int`,
      errors: sql<number>`count(*) filter (where ${requestLogs.outcome} <> 'ok')::int`,
      p50Ms: sql<number>`(percentile_cont(0.5) within group (order by ${requestLogs.latencyMs}))::int`,
      p95Ms: sql<number>`(percentile_cont(0.95) within group (order by ${requestLogs.latencyMs}))::int`,
    })
    .from(requestLogs)
    .where(and(gte(requestLogs.ts, dayStart), lt(requestLogs.ts, dayEnd)))
    .groupBy(requestLogs.provider);

  for (const agg of aggregates) {
    await db
      .insert(dailyRollups)
      .values({ day: dayIso, ...agg })
      .onConflictDoUpdate({
        target: [dailyRollups.day, dailyRollups.provider],
        set: {
          requests: agg.requests,
          errors: agg.errors,
          p50Ms: agg.p50Ms,
          p95Ms: agg.p95Ms,
        },
      });
  }

  const cutoff = new Date(Date.now() - retentionDays * 24 * 3_600_000);
  await db.delete(requestLogs).where(lt(requestLogs.ts, cutoff));
}

export async function listRollups(
  db: Db | null,
  days: number = 30,
): Promise<DailyRollup[]> {
  if (!db) return [];
  const since = new Date(Date.now() - days * 24 * 3_600_000)
    .toISOString()
    .slice(0, 10);
  return db
    .select()
    .from(dailyRollups)
    .where(gte(dailyRollups.day, since))
    .orderBy(dailyRollups.day);
}
