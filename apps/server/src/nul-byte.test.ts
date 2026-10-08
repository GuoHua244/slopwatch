import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { NormalEvent, QuarantineEvent } from "@slopwatch/events";
import type { Store } from "./store";

// Postgres text/jsonb cannot hold NUL (U+0000), and Windows tool output the
// listeners capture (wsl.exe UTF-16 leaks, binary spillover) carries real NUL
// bytes. The store strips them at the serialization boundary — these tests
// pin that boundary so one poison batch can never wedge the ingest path.
const dbTests = () =>
  (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL) !== undefined;
const testDsn = () =>
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!;

const NUL = "\u0000";

const startEvent = (sessionId: string): NormalEvent => ({
  schema_version: 1,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: "2026-10-08T00:00:00.000Z",
  kind: "session",
  event: "start",
  cwd: `C:\\work${NUL}\\repo`,
  hostname: "test-host",
});

const metaEvent = (sessionId: string): NormalEvent => ({
  schema_version: 1,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: "2026-10-08T00:00:01.000Z",
  kind: "session",
  event: "meta",
  title: `wsl${NUL} status report`,
  task_preview: `fix${NUL}things`,
});

const modelRequestEvent = (sessionId: string): NormalEvent => ({
  schema_version: 1,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: "2026-10-08T00:00:02.000Z",
  kind: "model_request",
  provider: "test",
  model: "test-model",
  duration_ms: 5,
  raw: {
    messages: [
      {
        role: "tool",
        content: `Exit code 1\n\r${NUL}Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\nW${NUL}`,
      },
    ],
  },
});

const quarantineEvent = (sessionId: string): QuarantineEvent => ({
  schema_version: 1,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: "2026-10-08T00:00:03.000Z",
  kind: "quarantine",
  event: "line",
  reason: "unknown record type: future_thing",
  line: `{"type":"future_thing","note":"bad${NUL}byte"}`,
});

describe.skipIf(!dbTests())("NUL bytes in captured content", () => {
  let store: Store | undefined;
  const ensure = async (): Promise<Store> => {
    if (store) return store;
    const { createPgStore } = await import("./store");
    store = createPgStore(testDsn());
    await store.migrate();
    return store;
  };

  test("a batch laced with NUL bytes stores stripped, not rejected", async () => {
    const s = await ensure();
    const sessionId = `sess_nul-${randomUUID()}`;
    const { accepted } = await s.appendEvents(
      [
        startEvent(sessionId),
        metaEvent(sessionId),
        modelRequestEvent(sessionId),
        quarantineEvent(sessionId),
      ],
      null,
    );
    expect(accepted).toBe(4);

    // The event log keeps the payload with NULs stripped and the surrounding
    // text intact — stripping must not corrupt the evidence around the byte.
    const events = await s.eventsSince(sessionId, 0);
    expect(events.length).toBe(3);
    expect(JSON.stringify(events).includes(NUL)).toBe(false);
    const kinds = new Map(events.map((e) => [e.event.kind, e.event]));
    const start = kinds.get("session");
    expect(start).toBeDefined();
    const startRows = events.filter((e) => e.event.kind === "session");
    expect(startRows.length).toBe(2);

    // The raw record (the poison column in the 2026-10-08 incident) is
    // retained with the NULs gone.
    const request = events.find((e) => e.event.kind === "model_request")!
      .event as { raw?: unknown };
    const raws = await s.rawForEvents(
      sessionId,
      events.map((e) => e.event_seq),
    );
    expect(raws.length).toBe(1);
    expect(JSON.stringify(raws[0]!.raw).includes(NUL)).toBe(false);
    expect(JSON.stringify(raws[0]!.raw)).toContain(
      "Wsl/Service/WSL_E_DISTRO_NOT_FOUND",
    );
    // keep the typecheck honest about the shape this test asserts on
    expect(request).toBeDefined();

    const session = await s.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.title).toBe("wsl status report");
    expect(session!.task_preview).toBe("fixthings");

    const rows = await s.listQuarantine(10);
    const mine = rows.find((r) => r.session_id === sessionId);
    expect(mine).toBeDefined();
    expect(mine!.line.includes(NUL)).toBe(false);
    expect(mine!.line).toContain("badbyte");
  });
});
