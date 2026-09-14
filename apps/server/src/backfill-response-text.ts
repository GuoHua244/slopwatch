/**
 * One-time maintenance: copy each zcode model_request's assistant response
 * text out of its retained raw rollout record into the event payload, so
 * turns captured before response_text shipped show the agent's answer too.
 * Idempotent — rows that already carry response_text, events without raw
 * (retention-archived), and non-string response texts are left alone.
 *
 * Usage: bun apps/server/src/backfill-response-text.ts   (reads DATABASE_URL)
 */
import { loadConfig } from "./config";
import { createPgStore } from "./store";

const config = loadConfig();
const store = createPgStore(config.databaseUrl);
const touched = await store.backfillResponseText();
await store.close();
console.log(`backfilled response text on ${touched} events`);
