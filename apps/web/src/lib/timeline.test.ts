import { describe, expect, test } from "bun:test";
import type { StoredEvent } from "../api";
import { buildTimeline, isEnded, mergeEvents } from "./timeline";

let seq = 0;
const ev = (event: Record<string, unknown>): StoredEvent => {
  seq += 1;
  return {
    event_seq: seq,
    event: {
      schema_version: 1,
      agent: "zcode",
      session_id: "sess_t",
      occurred_at: new Date(Date.UTC(2026, 8, 9, 15, 27, seq)).toISOString(),
      ...event,
    } as StoredEvent["event"],
  };
};

describe("buildTimeline", () => {
  test("groups requests and tools under explicit turn events", () => {
    const timeline = buildTimeline([
      ev({
        kind: "session",
        event: "start",
        cwd: "D:\\demo",
        hostname: "DEV-01",
      }),
      ev({
        kind: "turn",
        event: "start",
        turn_id: "turn_1",
        user_message: "fix the bug",
      }),
      ev({
        kind: "model_request",
        provider: "p",
        model: "m",
        duration_ms: 5,
        turn_id: "turn_1",
      }),
      ev({
        kind: "tool",
        event: "call",
        tool_call_id: "c1",
        tool: "Read",
        args: { file_path: "a.ts" },
      }),
      ev({
        kind: "tool",
        event: "result",
        tool_call_id: "c1",
        tool: "Read",
        ok: true,
        duration_ms: 12,
      }),
      ev({
        kind: "turn",
        event: "end",
        turn_id: "turn_1",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ]);
    expect(timeline.turns).toHaveLength(1);
    const turn = timeline.turns[0]!;
    expect(turn.turnId).toBe("turn_1");
    expect(turn.userMessage).toBe("fix the bug");
    expect(turn.modelRequests).toHaveLength(1);
    expect(turn.tools).toHaveLength(1);
    expect(turn.tools[0]!.call?.tool).toBe("Read");
    expect(turn.tools[0]!.result?.ok).toBe(true);
    expect(turn.usage?.input_tokens).toBe(10);
  });

  test("synthesizes turns for turn_ids never announced by a turn event", () => {
    const timeline = buildTimeline([
      ev({
        kind: "model_request",
        provider: "p",
        model: "m",
        duration_ms: 5,
        turn_id: "turn_b",
      }),
      ev({
        kind: "model_request",
        provider: "p",
        model: "m",
        duration_ms: 5,
        turn_id: "turn_a",
      }),
      ev({
        kind: "model_request",
        provider: "p",
        model: "m",
        duration_ms: 5,
        turn_id: "turn_b",
      }),
    ]);
    expect(timeline.turns.map((t) => t.turnId)).toEqual(["turn_b", "turn_a"]);
    expect(timeline.turns[0]!.modelRequests).toHaveLength(2);
    expect(timeline.turns[0]!.userMessage).toBeUndefined();
  });

  test("keeps the last non-empty response text as the turn's answer", () => {
    const timeline = buildTimeline([
      ev({
        kind: "model_request",
        provider: "p",
        model: "m",
        duration_ms: 5,
        turn_id: "turn_1",
        response_text: "checking the failing test",
      }),
      ev({
        kind: "model_request",
        provider: "p",
        model: "m",
        duration_ms: 5,
        turn_id: "turn_1",
      }),
      ev({
        kind: "model_request",
        provider: "p",
        model: "m",
        duration_ms: 5,
        turn_id: "turn_1",
        response_text: "fixed — all tests pass",
      }),
    ]);
    expect(timeline.turns[0]!.assistantMessage).toBe("fixed — all tests pass");
  });

  test("files tool events under the turn of the latest preceding request", () => {
    const timeline = buildTimeline([
      ev({
        kind: "model_request",
        provider: "p",
        model: "m",
        duration_ms: 5,
        turn_id: "turn_1",
      }),
      ev({ kind: "tool", event: "call", tool_call_id: "c1", tool: "Bash" }),
      ev({
        kind: "model_request",
        provider: "p",
        model: "m",
        duration_ms: 5,
        turn_id: "turn_2",
      }),
      ev({ kind: "tool", event: "call", tool_call_id: "c2", tool: "Read" }),
    ]);
    expect(timeline.turns.map((t) => t.turnId)).toEqual(["turn_1", "turn_2"]);
    expect(timeline.turns[0]!.tools[0]!.call?.tool).toBe("Bash");
    expect(timeline.turns[1]!.tools[0]!.call?.tool).toBe("Read");
  });

  test("pairs tool calls and results by tool_call_id", () => {
    const timeline = buildTimeline([
      ev({
        kind: "model_request",
        provider: "p",
        model: "m",
        duration_ms: 5,
        turn_id: "turn_1",
      }),
      ev({ kind: "tool", event: "call", tool_call_id: "c1", tool: "Bash" }),
      ev({
        kind: "tool",
        event: "result",
        tool_call_id: "c1",
        tool: "Bash",
        ok: false,
        error: "boom",
      }),
      ev({ kind: "tool", event: "result", tool_call_id: "c2", tool: "Read" }),
    ]);
    const [t1] = timeline.turns;
    expect(t1!.tools[0]!.call?.tool).toBe("Bash");
    expect(t1!.tools[0]!.result?.error).toBe("boom");
    // a result whose call never arrived files into the current turn
    expect(t1!.tools[1]!.result?.tool).toBe("Read");
    expect(timeline.orphans.tools).toHaveLength(0);
  });

  test("files events before any turn attribution into orphans", () => {
    const timeline = buildTimeline([
      ev({ kind: "tool", event: "call", tool_call_id: "c1", tool: "Read" }),
      ev({ kind: "model_request", provider: "p", model: "m", duration_ms: 5 }),
    ]);
    expect(timeline.turns).toHaveLength(0);
    expect(timeline.orphans.requests).toHaveLength(1);
    expect(timeline.orphans.tools).toHaveLength(1);
  });

  test("collects every session lifecycle event, not just the first", () => {
    const timeline = buildTimeline([
      ev({ kind: "session", event: "start", cwd: "a", hostname: "H1" }),
      ev({ kind: "session", event: "start", cwd: "b", hostname: "H1" }),
      ev({ kind: "session", event: "meta", title: "t1" }),
      ev({ kind: "session", event: "end", reason: "normal" }),
      ev({ kind: "session", event: "end", reason: "idle-timeout" }),
    ]);
    expect(timeline.starts).toHaveLength(2);
    expect(timeline.metas).toHaveLength(1);
    expect(timeline.ends.map((e) => e.reason)).toEqual([
      "normal",
      "idle-timeout",
    ]);
    expect(timeline.turns).toHaveLength(0);
  });

  test("collects summaries separately and they never affect isEnded", () => {
    const timeline = buildTimeline([
      ev({ kind: "session", event: "start", cwd: "a", hostname: "H1" }),
      ev({
        kind: "session",
        event: "summary",
        body: "Wrote the failing test first.",
        model: "glm-4",
      }),
      ev({ kind: "session", event: "end", reason: "idle-timeout" }),
      ev({
        kind: "session",
        event: "summary",
        body: "Everything green; pushed.",
        model: "glm-4",
      }),
    ]);
    expect(timeline.summaries.map((s) => s.body)).toEqual([
      "Wrote the failing test first.",
      "Everything green; pushed.",
    ]);
    // the end is the latest lifecycle word — a trailing summary must not
    // flip the session back to "running"
    expect(isEnded(timeline)).toBe(true);
  });

  test("isEnded: end after the latest start means ended, a later start means resumed", () => {
    const at = (iso: string, event: Record<string, unknown>): StoredEvent => {
      const stored = ev(event);
      stored.event.occurred_at = iso;
      return stored;
    };
    const ended = buildTimeline([
      at("2026-09-09T10:00:00Z", {
        kind: "session",
        event: "start",
        cwd: "a",
        hostname: "H",
      }),
      at("2026-09-09T11:00:00Z", {
        kind: "session",
        event: "end",
        reason: "idle-timeout",
      }),
    ]);
    expect(isEnded(ended)).toBe(true);
    const resumed = buildTimeline([
      at("2026-09-09T10:00:00Z", {
        kind: "session",
        event: "start",
        cwd: "a",
        hostname: "H",
      }),
      at("2026-09-09T11:00:00Z", {
        kind: "session",
        event: "end",
        reason: "idle-timeout",
      }),
      at("2026-09-09T12:00:00Z", {
        kind: "session",
        event: "start",
        cwd: "a",
        hostname: "H",
      }),
    ]);
    expect(isEnded(resumed)).toBe(false);
    const running = buildTimeline([
      at("2026-09-09T10:00:00Z", {
        kind: "session",
        event: "start",
        cwd: "a",
        hostname: "H",
      }),
    ]);
    expect(isEnded(running)).toBe(false);
  });
});

describe("mergeEvents", () => {
  const at = (n: number): StoredEvent => ({
    event_seq: n,
    event: ev({ kind: "session", event: "meta", title: "x" }).event,
  });

  test("appends new events and keeps seq order", () => {
    expect(
      mergeEvents([at(1), at(2)], [at(3), at(4)]).map((e) => e.event_seq),
    ).toEqual([1, 2, 3, 4]);
  });

  test("dedupes by event_seq, the incoming write winning", () => {
    const incoming = at(2);
    const merged = mergeEvents([at(1), at(2)], [incoming, at(3)]);
    expect(merged.map((e) => e.event_seq)).toEqual([1, 2, 3]);
    expect(merged.find((e) => e.event_seq === 2)).toBe(incoming);
  });

  test("sorts out-of-order pages", () => {
    expect(
      mergeEvents([at(5)], [at(2), at(1)]).map((e) => e.event_seq),
    ).toEqual([1, 2, 5]);
  });
});
