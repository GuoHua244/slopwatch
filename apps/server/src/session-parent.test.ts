import { describe, expect, test } from "bun:test";
import { SCHEMA_VERSION, type SessionStartEvent } from "@slopwatch/events";
import { Pool } from "pg";
import { createPgStore, type Store } from "./store";

const dbTests = () =>
  (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL) !== undefined;
const testDsn = () =>
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!;

const sessionStart = (
  sessionId: string,
  parentSessionId?: string,
): SessionStartEvent => ({
  schema_version: SCHEMA_VERSION,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: new Date().toISOString(),
  kind: "session",
  event: "start",
  cwd: "D:\\demo",
  hostname: "DEV-01",
  ...(parentSessionId ? { parent_session_id: parentSessionId } : {}),
});

describe.skipIf(!dbTests())("session parent link", () => {
  // created lazily so a missing DB surfaces as skipped, not a crash
  let store: Store | undefined;
  let pool: Pool | undefined;
  const ensure = async () => {
    if (store) return;
    store = createPgStore(testDsn());
    await store.migrate();
    pool = new Pool({ connectionString: testDsn() });
  };

  test("ingest lifts parent_session_id from the child's session:start", async () => {
    await ensure();
    const parentId = `sess_parent-${crypto.randomUUID().slice(0, 8)}`;
    const childId = `sess_child-${crypto.randomUUID().slice(0, 8)}`;
    await store!.appendEvents([sessionStart(parentId)], "alice");
    await store!.appendEvents([sessionStart(childId, parentId)], "alice");

    const rows = await store!.listSessions();
    const parent = rows.find((s) => s.session_id === parentId);
    const child = rows.find((s) => s.session_id === childId);
    expect(parent?.parent_session_id).toBeNull();
    expect(child?.parent_session_id).toBe(parentId);
  });

  test("migrate backfills legacy children from their event payload", async () => {
    await ensure();
    const parentId = `sess_parent-${crypto.randomUUID().slice(0, 8)}`;
    const childId = `sess_legacy-${crypto.randomUUID().slice(0, 8)}`;
    await store!.appendEvents(
      [sessionStart(parentId), sessionStart(childId, parentId)],
      "alice",
    );
    // Simulate a legacy row: the link predates the column, so only the
    // event payload carries it.
    await pool!.query(
      "UPDATE sessions SET parent_session_id = NULL WHERE session_id = $1",
      [childId],
    );
    await store!.migrate();

    const row = (await store!.listSessions()).find(
      (s) => s.session_id === childId,
    );
    expect(row?.parent_session_id).toBe(parentId);
  });

  test("cleanup", async () => {
    if (store) await store.close();
    if (pool) await pool.end();
  });
});
