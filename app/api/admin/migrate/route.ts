/**
 * POST /api/admin/migrate?secret=… — apply the schema (idempotent DDL).
 *
 * Exists because managed DATABASE_URL values are sensitive/write-only on
 * Vercel, so migrations must run where the env var lives. Gated on
 * REVALIDATE_SECRET; safe to call repeatedly (CREATE TABLE IF NOT EXISTS).
 */

import { neon } from "@neondatabase/serverless";
import { NextResponse } from "next/server";

const DDL = [
  `CREATE TABLE IF NOT EXISTS providers_snapshots (
    id serial PRIMARY KEY,
    provider text NOT NULL,
    ts timestamptz NOT NULL DEFAULT now(),
    ok boolean NOT NULL,
    latency_ms integer,
    http_status integer,
    advertised_limits jsonb,
    note text
  )`,
  `CREATE TABLE IF NOT EXISTS request_logs (
    id serial PRIMARY KEY,
    ts timestamptz NOT NULL DEFAULT now(),
    provider text NOT NULL,
    model text NOT NULL,
    model_class text,
    latency_ms integer,
    tokens_in integer,
    tokens_out integer,
    outcome text NOT NULL,
    fallback_depth integer NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS daily_rollups (
    day date NOT NULL,
    provider text NOT NULL,
    requests integer NOT NULL,
    errors integer NOT NULL,
    p50_ms integer,
    p95_ms integer,
    CONSTRAINT daily_rollups_day_provider_pk PRIMARY KEY (day, provider)
  )`,
];

export async function POST(req: Request): Promise<Response> {
  const secret = new URL(req.url).searchParams.get("secret");
  const expected = process.env.REVALIDATE_SECRET;
  if (!expected || secret !== expected) {
    return NextResponse.json({ ok: false, error: "invalid secret" }, { status: 401 });
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    return NextResponse.json({ ok: false, error: "DATABASE_URL not set" }, { status: 503 });
  }

  const sql = neon(url);
  for (const statement of DDL) {
    await sql.query(statement);
  }
  const tables = await sql.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' ORDER BY table_name`,
  );
  return NextResponse.json({
    ok: true,
    tables: (tables as Array<{ table_name: string }>).map((t) => t.table_name),
  });
}
