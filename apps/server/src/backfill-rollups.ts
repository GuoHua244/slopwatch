/**
 * One-time maintenance: seed the usage rollup tables from the events table —
 * they start empty on deployments that predate them, and every run recomputes
 * from truth, so re-running is always safe.
 *
 * Usage: bun apps/server/src/backfill-rollups.ts   (reads DATABASE_URL)
 */
import { loadConfig } from "./config";
import { createPgStore } from "./store";

const config = loadConfig();
const store = createPgStore(config.databaseUrl);
// The rollup tables may not exist yet on deployments predating decision 18.
await store.migrate();
const rows = await store.backfillRollups();
await store.close();
console.log(`backfilled ${rows} rollup rows`);
