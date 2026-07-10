/**
 * Daily rollup (spec §8 step 25) — aggregates yesterday's request_logs into
 * daily_rollups and deletes raw logs older than 30 days, keeping Neon under
 * the free tier's 0.5 GB. Run by .github/workflows/rollup.yml.
 */

import { getDb } from "../db/client";
import { rollupDay } from "../db/queries";

async function main() {
  const db = getDb();
  if (!db) {
    console.error("DATABASE_URL not set — nothing to roll up.");
    process.exitCode = 1;
    return;
  }
  const yesterday = new Date(Date.now() - 24 * 3_600_000)
    .toISOString()
    .slice(0, 10);
  await rollupDay(db, yesterday, 30);
  console.log(`rolled up ${yesterday}; pruned logs older than 30 days`);
}

main().catch((e) => {
  console.error("rollup failed:", e);
  process.exitCode = 1;
});
