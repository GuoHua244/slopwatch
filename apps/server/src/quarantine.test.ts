import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { NormalEvent, QuarantineEvent } from "@slopwatch/events";
import type { Store } from "./store";

// v2 decision 21: quarantined lines land in the quarantine store, count on
// the health page, and never enter the events log. DB-backed like the other
// store tests — skipped when no test database is configured.
const dbTests = () =>
  (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL) !== undefined;
const testDsn = () =>
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!;

const quarantineEvent = (sessionId: string): QuarantineEvent => ({
  schema_version: 1,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: "2026-09-13T00:00:00.000Z",
  kind: "quarantine",
  event: "line",
  reason: "unknown record type: future_thing",
  line: '{"type":"future_thing","payload":{"big":"blob"}}',
});

const startEvent = (sessionId: string): NormalEvent => ({
  schema_version: 1,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: "2026-09-13T00:00:00.000Z",
  kind: "session",
  event: "start",
  cwd: "C:\\work",
  hostname: "test-host",
});

describe.skipIf(!dbTests())("quarantine store semantics", () => {
  let store: Store | undefined;
  const ensure = async (): Promise<Store> => {
    if (store) return store;
    const { createPgStore } = await import("./store");
    store = createPgStore(testDsn());
    await store.migrate();
    return store;
  };

  test("quarantine events store verbatim lines without touching the event log", async () => {
    const s = await ensure();
    const sessionId = `sess_q-${randomUUID()}`;
    const { accepted } = await s.appendEvents(
      [startEvent(sessionId), quarantineEvent(sessionId)],
      null,
    );
    expect(accepted).toBe(2);

    // the quarantine line is not in the event log: the session's last_seq
    // covers only the normal event
    const events = await s.eventsSince(sessionId, 0);
    expect(events.length).toBe(1);
    expect(events[0]!.event.kind).toBe("session");

    const rows = await s.listQuarantine(10);
    const mine = rows.find((r) => r.session_id === sessionId);
    expect(mine).toBeDefined();
    expect(mine!.agent).toBe("zcode");
    expect(mine!.reason).toBe("unknown record type: future_thing");
    expect(mine!.line).toContain("future_thing");
  });

  test("health counts quarantine rows", async () => {
    const s = await ensure();
    const sessionId = `sess_q-${randomUUID()}`;
    await s.appendEvents([quarantineEvent(sessionId)], null);
    await s.appendEvents([quarantineEvent(sessionId)], null);
    const health = await s.health();
    expect(health.quarantine_total).toBeGreaterThanOrEqual(2);
    expect(health.quarantine_24h).toBeGreaterThanOrEqual(2);
    expect(health.last_quarantine_at).toBeTruthy();
  });

  test("listQuarantine limit is respected, newest first", async () => {
    const s = await ensure();
    const sessionId = `sess_q-${randomUUID()}`;
    for (let i = 0; i < 3; i += 1) {
      await s.appendEvents([quarantineEvent(sessionId)], null);
    }
    const rows = await s.listQuarantine(2);
    expect(rows.length).toBe(2);
    expect(rows[0]!.seq).toBeGreaterThan(rows[1]!.seq);
  });
});
