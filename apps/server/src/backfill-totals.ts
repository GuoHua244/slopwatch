/**
 * One-time maintenance: recompute the sessions token columns from the events
 * table. The columns only accumulated events appended after they shipped, so
 * sessions captured before that migration undercount; this rewrites each row
 * with the full sum. Idempotent and safe against a live Server — later
 * events keep accumulating on top.
 *
 * Usage: bun apps/server/src/backfill-totals.ts   (reads DATABASE_URL)
 */
import { loadConfig } from "./config";
import { createPgStore } from "./store";

const config = loadConfig();
const store = createPgStore(config.databaseUrl);
const touched = await store.backfillTokenTotals();
await store.close();
console.log(`backfilled token totals for ${touched} sessions`);
