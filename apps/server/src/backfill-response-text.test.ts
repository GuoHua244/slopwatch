import { describe, expect, test } from "bun:test";
import {
  SCHEMA_VERSION,
  type ModelRequestEvent,
  type SessionStartEvent,
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
  raw: unknown,
  agent = "zcode",
): ModelRequestEvent => ({
  schema_version: SCHEMA_VERSION,
  agent,
  session_id: sessionId,
  occurred_at: new Date().toISOString(),
  kind: "model_request",
  provider: "p",
  model: "m",
  duration_ms: 5,
  raw,
});

describe.skipIf(!dbTests())("backfillResponseText", () => {
  // created lazily so a missing DB surfaces as skipped, not a crash
  let store: Store | undefined;
  let pool: Pool | undefined;
  const ensure = async () => {
    if (store) return;
    store = createPgStore(testDsn());
    await store.migrate();
    pool = new Pool({ connectionString: testDsn() });
  };

  test("copies raw.response.text into payload.response_text once", async () => {
    await ensure();
    const sessionId = `sess_backfill-rt-${crypto.randomUUID().slice(0, 8)}`;
    await store!.appendEvents(
      [
        sessionStart(sessionId),
        modelRequest(sessionId, {
          querySource: "model_io",
          response: { text: "the assistant said this" },
        }),
      ],
      "alice",
    );

    const filled = await store!.backfillResponseText();
    expect(filled).toBeGreaterThanOrEqual(1);

    const { rows } = await pool!.query(
      "SELECT payload->>'response_text' AS rt FROM events WHERE session_id = $1 AND kind = 'model_request'",
      [sessionId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rt).toBe("the assistant said this");

    // re-run is a no-op for already-filled rows (the IS NULL guard)
    const again = await store!.backfillResponseText();
    const { rows: after } = await pool!.query(
      "SELECT payload->>'response_text' AS rt FROM events WHERE session_id = $1 AND kind = 'model_request'",
      [sessionId],
    );
    expect(after[0]!.rt).toBe("the assistant said this");
    expect(again).toBeGreaterThanOrEqual(0);
  });

  test("skips title echoes, non-string text, empty text, and other agents", async () => {
    await ensure();
    const sessionId = `sess_backfill-rt-${crypto.randomUUID().slice(0, 8)}`;
    await store!.appendEvents(
      [
        sessionStart(sessionId),
        // session_title echoes a JSON title payload, not speech
        modelRequest(sessionId, {
          querySource: "session_title",
          response: { text: '{"title":"t"}' },
        }),
        // non-string response.text
        modelRequest(sessionId, {
          querySource: "model_io",
          response: { text: 42 },
        }),
        // empty string text
        modelRequest(sessionId, {
          querySource: "model_io",
          response: { text: "" },
        }),
        // wrong agent — only zcode raw carries the echoed response shape
        modelRequest(
          sessionId,
          { response: { text: "claude said" } },
          "claude-code",
        ),
      ],
      "alice",
    );
    const before = await pool!.query(
      "SELECT count(*) AS n FROM events WHERE session_id = $1 AND payload ? 'response_text'",
      [sessionId],
    );
    await store!.backfillResponseText();
    const after = await pool!.query(
      "SELECT count(*) AS n FROM events WHERE session_id = $1 AND payload ? 'response_text'",
      [sessionId],
    );
    expect(Number(after.rows[0]!.n)).toBe(Number(before.rows[0]!.n));
    expect(Number(after.rows[0]!.n)).toBe(0);
  });

  test("cleanup", async () => {
    await ensure();
    await pool!.query(
      "DELETE FROM events WHERE session_id LIKE 'sess_backfill-rt-%'",
    );
    await pool!.query(
      "DELETE FROM sessions WHERE session_id LIKE 'sess_backfill-rt-%'",
    );
  });
});
