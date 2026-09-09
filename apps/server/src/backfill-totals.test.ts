import { describe, expect, test } from "bun:test";
import {
  SCHEMA_VERSION,
  type ModelRequestEvent,
  type SessionStartEvent,
  type TokenUsage,
} from "@slopwatch/events";
import { Pool } from "pg";
import { createPgStore, type Store } from "./store";

const dbTests = () =>
  (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL) !== undefined;
const testDsn = () =>
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!;

const sessionStart = (sessionId: string): SessionStartEvent => ({
  schema_version: 1,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: new Date().toISOString(),
  kind: "session",
  event: "start",
  cwd: "D:\\demo",
  hostname: "DEV-01",
});

const modelRequest = (
  sessionId: string,
  usage: TokenUsage,
): ModelRequestEvent => ({
  schema_version: SCHEMA_VERSION,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: new Date().toISOString(),
  kind: "model_request",
  provider: "p",
  model: "m",
  duration_ms: 5,
  usage,
});

describe.skipIf(!dbTests())("backfillTokenTotals", () => {
  // created lazily so a missing DB surfaces as skipped, not a crash
  let store: Store | undefined;
  let pool: Pool | undefined;
  const ensure = async () => {
    if (store) return;
    store = createPgStore(testDsn());
    await store.migrate();
    pool = new Pool({ connectionString: testDsn() });
  };

  test("recomputes the token columns from the events table", async () => {
    await ensure();
    const sessionId = `sess_backfill-${crypto.randomUUID().slice(0, 8)}`;
    await store!.appendEvents(
      [
        sessionStart(sessionId),
        modelRequest(sessionId, {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 10,
          cache_write_tokens: 2,
        }),
        modelRequest(sessionId, { input_tokens: 30, output_tokens: 5 }),
      ],
      "alice",
    );

    // Simulate the legacy undercount: totals only accumulated events that
    // were appended after the columns shipped.
    await pool!.query(
      `UPDATE sessions SET total_input_tokens = 0, total_output_tokens = 0,
       total_cache_read_tokens = 0, total_cache_write_tokens = 0
       WHERE session_id = $1`,
      [sessionId],
    );
    const zeroed = (await store!.listSessions()).find(
      (s) => s.session_id === sessionId,
    );
    expect(zeroed?.total_input_tokens).toBe(0);

    const touched = await store!.backfillTokenTotals();
    expect(touched).toBeGreaterThanOrEqual(1);
    const row = (await store!.listSessions()).find(
      (s) => s.session_id === sessionId,
    );
    expect(row?.total_input_tokens).toBe(130);
    expect(row?.total_output_tokens).toBe(55);
    expect(row?.total_cache_read_tokens).toBe(10);
    expect(row?.total_cache_write_tokens).toBe(2);
  });

  test("cleanup", async () => {
    if (store) await store.close();
    if (pool) await pool.end();
  });
});
