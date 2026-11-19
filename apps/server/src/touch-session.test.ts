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
  agent: "codex" | "zcode",
): SessionStartEvent => ({
  schema_version: SCHEMA_VERSION,
  agent,
  session_id: sessionId,
  occurred_at: new Date().toISOString(),
  kind: "session",
  event: "start",
  cwd: "D:\\demo",
  hostname: "DEV-01",
});

describe.skipIf(!dbTests())("touchSession against Postgres", () => {
  // created lazily so a missing DB surfaces as skipped, not a crash
  let store: Store | undefined;
  let pool: Pool | undefined;
  const ensure = async () => {
    if (store) return;
    store = createPgStore(testDsn());
    await store.migrate();
    pool = new Pool({ connectionString: testDsn() });
  };

  test("bump lands past the debounce window, agent-guarded, cursor intact", async () => {
    await ensure();
    const codexId = `codex-lock-${crypto.randomUUID().slice(0, 8)}`;
    const zcodeId = `zcode-lock-${crypto.randomUUID().slice(0, 8)}`;
    await store!.appendEvents([sessionStart(codexId, "codex")], "alice");
    await store!.appendEvents([sessionStart(zcodeId, "zcode")], "alice");

    // ingest just stamped last_event_at — inside the 30s debounce window
    expect(await store!.touchSession(codexId)).toBe(false);

    // the agent guard: a zcode session id must never be bumpable by the
    // codex lock echo, even well past the debounce window
    await pool!.query(
      "UPDATE sessions SET last_event_at = now() - interval '5 minutes' WHERE session_id = $1",
      [zcodeId],
    );
    expect(await store!.touchSession(zcodeId)).toBe(false);

    // past the window the bump lands: last_event_at moves to now, while
    // last_seq — the listeners' tail cursor — stays put
    await pool!.query(
      "UPDATE sessions SET last_event_at = now() - interval '5 minutes' WHERE session_id = $1",
      [codexId],
    );
    const before = await store!.getSession(codexId);
    expect(await store!.touchSession(codexId)).toBe(true);
    const after = await store!.getSession(codexId);
    expect(after!.last_seq).toBe(before!.last_seq);
    expect(after!.last_event_at).not.toBeNull();
    expect(Date.now() - new Date(after!.last_event_at!).getTime()).toBeLessThan(
      10_000,
    );

    // a thread that was never captured is a silent no-op
    expect(
      await store!.touchSession(
        `codex-lock-${crypto.randomUUID().slice(0, 8)}`,
      ),
    ).toBe(false);
  });
});
