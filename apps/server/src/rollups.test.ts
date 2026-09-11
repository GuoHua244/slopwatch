import { describe, expect, test } from "bun:test";
import {
  SCHEMA_VERSION,
  type ModelRequestEvent,
  type NormalEvent,
  type SessionStartEvent,
  type ToolCallEvent,
  type TurnStartEvent,
} from "@slopwatch/events";
import { rollupDeltas, utcDay, utcHour } from "./rollups";

// 2026-09-11T17:00:00Z — 2026-09-12 01:00 in UTC+8, so a local-time bucket
// would land on the wrong side of the day line.
const CROSS_TZ = "2026-09-12T01:00:00+08:00";

const sessionStart = (
  sessionId: string,
  occurredAt: string,
): SessionStartEvent => ({
  schema_version: SCHEMA_VERSION,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: occurredAt,
  kind: "session",
  event: "start",
  cwd: "D:\\demo",
  hostname: "DEV-01",
});

const turnStart = (sessionId: string, occurredAt: string): TurnStartEvent => ({
  schema_version: SCHEMA_VERSION,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: occurredAt,
  kind: "turn",
  event: "start",
  turn_id: "t1",
});

const toolCall = (sessionId: string, occurredAt: string): ToolCallEvent => ({
  schema_version: SCHEMA_VERSION,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: occurredAt,
  kind: "tool",
  event: "call",
  tool_call_id: "c1",
  tool: "Bash",
});

const modelRequest = (
  sessionId: string,
  occurredAt: string,
  model: string,
  usage?: ModelRequestEvent["usage"],
): ModelRequestEvent => ({
  schema_version: SCHEMA_VERSION,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: occurredAt,
  kind: "model_request",
  provider: "p",
  model,
  duration_ms: 5,
  usage,
});

describe("utc buckets", () => {
  test("day and hour cut at UTC, not the event's local offset", () => {
    expect(utcDay(CROSS_TZ)).toBe("2026-09-11");
    expect(utcHour(CROSS_TZ)).toBe("2026-09-11T17");
  });
});

describe("rollupDeltas", () => {
  test("counts turn starts and tool calls per UTC day; other kinds are ignored", () => {
    const deltas = rollupDeltas([
      sessionStart("s", CROSS_TZ),
      turnStart("s", CROSS_TZ),
      { ...turnStart("s", CROSS_TZ), event: "end", turn_id: "t1" },
      toolCall("s", CROSS_TZ),
      { ...toolCall("s", CROSS_TZ), event: "result" },
      { ...sessionStart("s", CROSS_TZ), event: "end", reason: "normal" },
    ]);
    expect([...deltas.daily]).toEqual([
      ["2026-09-11", { turns: 1, toolCalls: 1 }],
    ]);
    expect(deltas.modelDaily.size).toBe(0);
    expect(deltas.modelHourly.size).toBe(0);
  });

  test("groups model requests by model with token sums, daily and hourly", () => {
    const nextHour = "2026-09-11T19:30:00Z";
    const deltas = rollupDeltas([
      modelRequest("s", CROSS_TZ, "m1", {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 10,
        cache_write_tokens: 2,
      }),
      modelRequest("s", CROSS_TZ, "m2"),
      modelRequest("s", nextHour, "m1", { input_tokens: 30, output_tokens: 5 }),
    ]);
    const m1 = deltas.modelDaily.get("2026-09-11")?.get("m1");
    expect(m1).toEqual({
      modelRequests: 2,
      inputTokens: 130,
      outputTokens: 55,
      cacheReadTokens: 10,
      cacheWriteTokens: 2,
    });
    expect(deltas.modelDaily.get("2026-09-11")?.get("m2")).toEqual({
      modelRequests: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    // The 17z and 19z requests are distinct hourly buckets.
    expect([...deltas.modelHourly.keys()].sort()).toEqual([
      "2026-09-11T17",
      "2026-09-11T19",
    ]);
    expect(deltas.modelHourly.get("2026-09-11T17")?.get("m2")).toBeDefined();
  });

  test("requests in the same hour accumulate into one bucket", () => {
    const deltas = rollupDeltas([
      modelRequest("s", CROSS_TZ, "m1", { input_tokens: 1 }),
      modelRequest("s", "2026-09-11T17:59:00Z", "m1", { input_tokens: 2 }),
    ]);
    expect(deltas.modelHourly.get("2026-09-11T17")?.get("m1")).toMatchObject({
      modelRequests: 2,
      inputTokens: 3,
    });
  });
});

// --- Postgres-backed tests for the store-side rollup plumbing ---

const dbTests = () =>
  (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL) !== undefined;
const testDsn = () =>
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!;

describe.skipIf(!dbTests())("rollup persistence", () => {
  // created lazily so a missing DB surfaces as skipped, not a crash
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

  // A run-unique rollup user keeps assertions exact on a persistent test DB.
  const freshUser = (): string => `rollup-${crypto.randomUUID().slice(0, 8)}`;

  test("appendEvents upserts day, model-day, and model-hour rows", async () => {
    await ensure();
    const user = freshUser();
    const sid = `sess_roll-${crypto.randomUUID().slice(0, 8)}`;
    await store!.appendEvents(
      [
        sessionStart(sid, CROSS_TZ),
        turnStart(sid, CROSS_TZ),
        toolCall(sid, CROSS_TZ),
        modelRequest(sid, CROSS_TZ, "m1", {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 10,
          cache_write_tokens: 2,
        }),
      ],
      user,
    );

    let snap = await store!.listRollups("2000-01-01", "2000-01-01T00");
    expect(snap.daily.filter((r) => r.user_id === user)).toEqual([
      { user_id: user, day: "2026-09-11", turns: 1, tool_calls: 1 },
    ]);
    expect(
      snap.model_daily.find((r) => r.user_id === user && r.model === "m1"),
    ).toEqual({
      user_id: user,
      bucket: "2026-09-11",
      model: "m1",
      model_requests: 1,
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 10,
      cache_write_tokens: 2,
    });
    expect(
      snap.model_hourly.find((r) => r.user_id === user && r.model === "m1")
        ?.bucket,
    ).toBe("2026-09-11T17");

    // A second batch accumulates on top instead of overwriting.
    await store!.appendEvents(
      [
        turnStart(sid, CROSS_TZ),
        modelRequest(sid, CROSS_TZ, "m1", {
          input_tokens: 30,
          output_tokens: 5,
        }),
        modelRequest(sid, CROSS_TZ, "m2"),
      ],
      user,
    );
    snap = await store!.listRollups("2000-01-01", "2000-01-01T00");
    expect(snap.daily.find((r) => r.user_id === user)).toMatchObject({
      turns: 2,
      tool_calls: 1,
    });
    expect(
      snap.model_daily.find((r) => r.user_id === user && r.model === "m1"),
    ).toMatchObject({ model_requests: 2, input_tokens: 130 });
    expect(
      snap.model_daily.find((r) => r.user_id === user && r.model === "m2"),
    ).toMatchObject({ model_requests: 1 });
    const totals = snap.totals.find((r) => r.user_id === user);
    expect(totals).toMatchObject({ turns: 2, tool_calls: 1 });
    expect(
      snap.model_totals.find((r) => r.user_id === user && r.model === "m1"),
    ).toMatchObject({ model_requests: 2, input_tokens: 130 });
  });

  test("deleteSession recomputes the owner's rollups from remaining events", async () => {
    await ensure();
    const user = freshUser();
    const keep = `sess_roll-${crypto.randomUUID().slice(0, 8)}`;
    const drop = `sess_roll-${crypto.randomUUID().slice(0, 8)}`;
    const usage = { input_tokens: 10, output_tokens: 1 };
    await store!.appendEvents(
      [modelRequest(keep, CROSS_TZ, "m1", usage)],
      user,
    );
    await store!.appendEvents(
      [sessionStart(drop, CROSS_TZ), modelRequest(drop, CROSS_TZ, "m1", usage)],
      user,
    );
    expect(
      (
        await store!.listRollups("2000-01-01", "2000-01-01T00")
      ).model_totals.find((r) => r.user_id === user && r.model === "m1"),
    ).toMatchObject({ model_requests: 2 });

    expect(await store!.deleteSession(drop)).toBe(true);
    expect(
      (
        await store!.listRollups("2000-01-01", "2000-01-01T00")
      ).model_totals.find((r) => r.user_id === user && r.model === "m1"),
    ).toMatchObject({ model_requests: 1, input_tokens: 10 });
    // The dropped session was the only one with a turn — the flat row is gone.
    expect(
      (await store!.listRollups("2000-01-01", "2000-01-01T00")).totals.find(
        (r) => r.user_id === user,
      ),
    ).toBeUndefined();
  });

  test("backfillRollups rebuilds every table from the events table", async () => {
    await ensure();
    const user = freshUser();
    const sid = `sess_roll-${crypto.randomUUID().slice(0, 8)}`;
    await store!.appendEvents(
      [
        sessionStart(sid, CROSS_TZ),
        turnStart(sid, CROSS_TZ),
        modelRequest(sid, CROSS_TZ, "m1", {
          input_tokens: 7,
          output_tokens: 3,
        }),
      ],
      user,
    );
    for (const table of [
      "user_daily_rollup",
      "model_daily_rollup",
      "model_hourly_rollup",
    ]) {
      await pool!.query(`DELETE FROM ${table} WHERE user_id = $1`, [user]);
    }
    const rows = await store!.backfillRollups();
    expect(rows).toBeGreaterThanOrEqual(1);
    const snap = await store!.listRollups("2000-01-01", "2000-01-01T00");
    expect(snap.daily.find((r) => r.user_id === user)).toMatchObject({
      turns: 1,
      tool_calls: 0,
    });
    expect(
      snap.model_daily.find((r) => r.user_id === user && r.model === "m1"),
    ).toMatchObject({ model_requests: 1, input_tokens: 7 });
  });

  test("cleanup", async () => {
    if (store) await store.close();
    if (pool) await pool.end();
  });
});
