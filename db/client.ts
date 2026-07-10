/**
 * Drizzle client over Neon's HTTP driver (works on Vercel Edge and Node).
 * Returns null when DATABASE_URL is unset so local dev and tests degrade
 * gracefully instead of crashing at import time.
 */

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import * as schema from "./schema";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

let cached: Db | null | undefined;

export function getDb(): Db | null {
  if (cached !== undefined) return cached;
  const url = process.env.DATABASE_URL;
  cached = url ? drizzle(neon(url), { schema }) : null;
  return cached;
}
