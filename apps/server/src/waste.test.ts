import { describe, expect, test } from "bun:test";
import {
  SCHEMA_VERSION,
  type NormalEvent,
  type SessionStartEvent,
  type ToolCallEvent,
  type ToolResultEvent,
} from "@slopwatch/events";

/**
 * v3 decision 31: the waste counters. The load-bearing assertion is parity —
 * what the ingest transaction accumulates incrementally must equal what
 * recomputeRollups/recomputeSessionWaste rebuild from the events table, or
 * the "aggregates can never drift from the events" property (decision 18)
 * breaks for the new counters.
 */

const start = (sessionId: string): SessionStartEvent => ({
  schema_version: SCHEMA_VERSION,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: "2026-09-11T17:00:00Z",
  kind: "session",
  event: "start",
  cwd: "D:\\demo",
  hostname: "DEV-01",
});

const call = (
  sessionId: string,
  toolCallId: string,
  args?: unknown,
  occurredAt = "2026-09-11T17:01:00Z",
): ToolCallEvent => ({
  schema_version: SCHEMA_VERSION,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: occurredAt,
  kind: "tool",
  event: "call",
  tool_call_id: toolCallId,
  tool: "Bash",
  ...(args !== undefined ? { args } : {}),
});

const result = (
  sessionId: string,
  toolCallId: string,
  ok: boolean,
  occurredAt = "2026-09-11T17:01:05Z",
): ToolResultEvent => ({
  schema_version: SCHEMA_VERSION,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: occurredAt,
  kind: "tool",
  event: "result",
  tool_call_id: toolCallId,
  tool: "Bash",
  ok,
  ...(ok ? {} : { error: "boom" }),
});

const dbTests = () =>
  (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL) !== undefined;
const testDsn = () =>
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!;

describe.skipIf(!dbTests())("waste counters", () => {
  let store: import("./store").Store | undefined;
  let pool: import("pg").Pool | undefined;
  const ensure = async () => {
    if (store) return;
    const { createPgStore } = await import("./store");
    store = createPgStore(testDsn());
    await store.migrate();
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: testDsn() });
  };

  const freshUser = (): string => `waste-${crypto.randomUUID().slice(0, 8)}`;
  const freshSession = (): string =>
    `sess_waste-${crypto.randomUUID().slice(0, 8)}`;

  const sessionCols = async (sessionId: string) => {
    const { rows } = await pool!.query(
      "SELECT failed_tool_calls, repeated_calls FROM sessions WHERE session_id = $1",
      [sessionId],
    );
    return rows[0] as { failed_tool_calls: string; repeated_calls: string };
  };

  const wasteTotals = async (user: string) => {
    const snap = await store!.listRollups("2000-01-01", "2000-01-01T00");
    return snap.totals.find((r) => r.user_id === user);
  };

  test("failures and repeated identical calls count exactly, per session and rollup", async () => {
    await ensure();
    const user = freshUser();
    const sid = freshSession();
    // Two identical calls (same tool, same args): the second is a repeat.
    // One failed result. One call with different args: neither repeat nor
    // failure. One failed result for the different call.
    const events: NormalEvent[] = [
      start(sid),
      call(sid, "c1", { command: "bun test" }),
      call(sid, "c2", { command: "bun test" }),
      result(sid, "c1", false),
      result(sid, "c2", true),
      call(sid, "c3", { command: "bun lint" }),
      result(sid, "c3", false),
    ];
    await store!.appendEvents(events, user);

    const cols = await sessionCols(sid);
    expect(Number(cols.failed_tool_calls)).toBe(2);
    expect(Number(cols.repeated_calls)).toBe(1);

    const totals = await wasteTotals(user);
    expect(totals).toMatchObject({
      tool_calls: 3,
      failed_tool_calls: 2,
      repeated_calls: 1,
    });
  });

  test("repeats count across batches; the pair's first occurrence never does", async () => {
    await ensure();
    const user = freshUser();
    const sid = freshSession();
    await store!.appendEvents(
      [start(sid), call(sid, "c1", { path: "a.ts" })],
      user,
    );
    expect(Number((await sessionCols(sid)).repeated_calls)).toBe(0);
    // A later batch repeating the identical pair is one repeat.
    await store!.appendEvents([call(sid, "c2", { path: "a.ts" })], user);
    expect(Number((await sessionCols(sid)).repeated_calls)).toBe(1);
    // Same tool, different args: not the same pair, not a repeat.
    await store!.appendEvents([call(sid, "c3", { path: "b.ts" })], user);
    expect(Number((await sessionCols(sid)).repeated_calls)).toBe(1);
  });

  test("args group semantically: key order does not dodge the repeat", async () => {
    await ensure();
    const user = freshUser();
    const sid = freshSession();
    await store!.appendEvents(
      [start(sid), call(sid, "c1", { a: 1, b: [2, 3] })],
      user,
    );
    // Same args, differently ordered object keys — jsonb equality is
    // semantic, so this is the same pair and counts as a repeat.
    await store!.appendEvents([call(sid, "c2", { b: [2, 3], a: 1 })], user);
    expect(Number((await sessionCols(sid)).repeated_calls)).toBe(1);
  });

  test("a failed result with ok: true absent or true never counts", async () => {
    await ensure();
    const user = freshUser();
    const sid = freshSession();
    await store!.appendEvents(
      [
        start(sid),
        call(sid, "c1"),
        result(sid, "c1", true),
        call(sid, "c2"),
        { ...result(sid, "c2", true), ok: undefined },
      ],
      user,
    );
    expect(Number((await sessionCols(sid)).failed_tool_calls)).toBe(0);
    expect((await wasteTotals(user))?.failed_tool_calls).toBe(0);
  });

  test("recompute parity: backfill leaves every waste counter unchanged", async () => {
    await ensure();
    const user = freshUser();
    const sid = freshSession();
    await store!.appendEvents(
      [
        start(sid),
        call(sid, "c1", { command: "bun test" }),
        call(sid, "c2", { command: "bun test" }),
        result(sid, "c1", false),
        call(sid, "c3", { command: "bun test" }),
        result(sid, "c3", false),
      ],
      user,
    );
    const before = await sessionCols(sid);
    const totalsBefore = await wasteTotals(user);
    await store!.backfillRollups();
    const after = await sessionCols(sid);
    expect(Number(after.failed_tool_calls)).toBe(
      Number(before.failed_tool_calls),
    );
    expect(Number(after.repeated_calls)).toBe(Number(before.repeated_calls));
    const totalsAfter = await wasteTotals(user);
    expect(totalsAfter).toEqual(totalsBefore);
  });

  test("deleteSession recomputes the owner's waste counters from remaining events", async () => {
    await ensure();
    const user = freshUser();
    const keep = freshSession();
    const drop = freshSession();
    await store!.appendEvents(
      [start(keep), call(keep, "c1"), result(keep, "c1", false)],
      user,
    );
    await store!.appendEvents(
      [
        start(drop),
        call(drop, "c1"),
        result(drop, "c1", false),
        call(drop, "c2"),
        result(drop, "c2", false),
      ],
      user,
    );
    expect((await wasteTotals(user))?.failed_tool_calls).toBe(3);
    await store!.deleteSession(drop);
    expect(await wasteTotals(user)).toMatchObject({
      tool_calls: 1,
      failed_tool_calls: 1,
      repeated_calls: 0,
    });
  });

  test("cleanup", async () => {
    if (store) await store.close();
    if (pool) await pool.end();
  });
});
