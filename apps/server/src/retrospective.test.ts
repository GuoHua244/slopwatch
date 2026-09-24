import { describe, expect, test } from "bun:test";
import type { StoredEvent } from "./store";
import {
  DEFAULT_ANGLES,
  CUSTOM_ANGLE_ID,
  RETRO_SYSTEM_CORE,
  effectiveRetroAngles,
  parseRetroAngles,
} from "./retrospective/presets";
import {
  RAW_EVIDENCE_CAP_CHARS,
  buildTranscript,
  estimateTokens,
  extractRawEvidence,
  failureRawSeqs,
} from "./retrospective/transcript";
import type { ChildSessionRollup, SessionRow } from "./store";
import type { NormalEvent } from "@slopwatch/events";

// ---- fixtures -------------------------------------------------------------

let seq = 0;
const ev = (event: NormalEvent): StoredEvent => ({
  event_seq: ++seq,
  event,
});
const turnStart = (turnId: string, message?: string): StoredEvent =>
  ev({
    schema_version: 1,
    agent: "zcode",
    session_id: "s1",
    occurred_at: "2026-09-25T00:00:00Z",
    kind: "turn",
    event: "start",
    turn_id: turnId,
    ...(message !== undefined ? { user_message: message } : {}),
  });
const request = (turnId: string, model = "glm-4.6"): StoredEvent =>
  ev({
    schema_version: 1,
    agent: "zcode",
    session_id: "s1",
    occurred_at: "2026-09-25T00:00:01Z",
    kind: "model_request",
    provider: "zai",
    model,
    duration_ms: 1200,
    turn_id: turnId,
    usage: {
      input_tokens: 12_000,
      output_tokens: 800,
      cache_read_tokens: 9_000,
    },
    response_text: "Thinking about the task.",
  });
const call = (
  turnId: string,
  id: string,
  tool: string,
  args?: unknown,
): StoredEvent =>
  ev({
    schema_version: 1,
    agent: "zcode",
    session_id: "s1",
    occurred_at: "2026-09-25T00:00:02Z",
    kind: "tool",
    event: "call",
    tool_call_id: id,
    tool,
    ...(args !== undefined ? { args } : {}),
  });
const result = (
  turnId: string,
  id: string,
  ok: boolean,
  error?: string,
): StoredEvent =>
  ev({
    schema_version: 1,
    agent: "zcode",
    session_id: "s1",
    occurred_at: "2026-09-25T00:00:03Z",
    kind: "tool",
    event: "result",
    tool_call_id: id,
    tool: "Bash",
    duration_ms: 300,
    ok,
    ...(error !== undefined ? { error } : {}),
  });

const sessionRow = (): SessionRow => ({
  session_id: "s1",
  agent: "zcode",
  user_id: "alice",
  team_id: null,
  first_seen_at: "2026-09-25T00:00:00.000Z",
  last_event_at: "2026-09-25T01:00:00.000Z",
  last_seq: 10,
  title: "Fix the flaky test",
  task_preview: "make ci green",
  total_input_tokens: 100_000,
  total_output_tokens: 5_000,
  total_cache_read_tokens: 80_000,
  total_cache_write_tokens: 0,
});

const child = (): ChildSessionRollup => ({
  session_id: "child1",
  agent: "zcode",
  title: "sub task",
  task_preview: null,
  input_tokens: 1_500_000,
  output_tokens: 45_000,
  cache_read_tokens: 900_000,
  cache_write_tokens: 0,
  turns: 12,
  model_requests: 30,
  tool_calls: 40,
  tool_errors: 3,
  tools: [
    { tool: "Read", calls: 12 },
    { tool: "Bash", calls: 10 },
  ],
  first_user_message: "go fix it",
  sub_sessions: 2,
});

// ---- transcript -----------------------------------------------------------

describe("buildTranscript", () => {
  test("renders turns with user message, requests, calls, and results", () => {
    const text = buildTranscript({
      session: sessionRow(),
      events: [
        turnStart("t1", "please fix the bug"),
        request("t1"),
        call("t1", "c1", "Bash", { command: "bun test" }),
        result("t1", "c1", true),
      ],
      children: [],
      rawBySeq: new Map(),
    }).text;
    expect(text).toContain("# Session transcript");
    expect(text).toContain("## Turn t1");
    expect(text).toContain("user: please fix the bug");
    expect(text).toContain("model=glm-4.6");
    expect(text).toContain("in 12.0k");
    expect(text).toContain('args: {"command":"bun test"}');
    expect(text).toContain("→ ok");
  });

  test("marks failed calls with their error text", () => {
    const text = buildTranscript({
      session: sessionRow(),
      events: [
        turnStart("t1", "run it"),
        request("t1"),
        call("t1", "c1", "Bash", { command: "make" }),
        result("t1", "c1", false, "make: not found"),
      ],
      children: [],
      rawBySeq: new Map(),
    }).text;
    expect(text).toContain("→ FAILED");
    expect(text).toContain("make: not found");
  });

  test("extracts raw evidence for failed calls from the echoed request record", () => {
    const events = [
      turnStart("t1", "run it"),
      request("t1"),
      call("t1", "c1", "Bash", { command: "make" }),
      result("t1", "c1", false, "make: not found"),
    ];
    // the turn's last model request is the record that echoes the failure
    const requestSeq = events[1]!.event_seq;
    const raw = {
      request: {
        messages: [
          { role: "user", content: "run it" },
          { role: "assistant", content: [] },
          {
            role: "tool",
            tool_call_id: "c1",
            content: "sh: make: command not found — full context here",
          },
        ],
      },
    };
    const out = buildTranscript({
      session: sessionRow(),
      events,
      children: [],
      rawBySeq: new Map([[requestSeq, raw]]),
    });
    expect(out.enrichedTurns).toBe(1);
    expect(out.text).toContain("raw evidence for failed call(s) c1");
    expect(out.text).toContain("sh: make: command not found");
  });

  test("notes raw evidence missing when the record has expired", () => {
    const events = [
      turnStart("t1", "run it"),
      request("t1"),
      call("t1", "c1", "Bash", {}),
      result("t1", "c1", false, "boom"),
    ];
    const text = buildTranscript({
      session: sessionRow(),
      events,
      children: [],
      rawBySeq: new Map(),
    }).text;
    expect(text).toContain("raw evidence missing");
  });

  test("compacts the oldest turns when the budget is tight, keeping the newest", () => {
    const events: StoredEvent[] = [];
    for (let i = 1; i <= 6; i++) {
      events.push(turnStart(`t${i}`, `task ${i}`));
      events.push(request(`t${i}`));
      events.push(call(`t${i}`, `c${i}`, "Bash", { command: `cmd ${i}` }));
      events.push(result(`t${i}`, `c${i}`, true));
    }
    const tiny = 400; // tokens — the reserve eats most of it; only the
    // newest turn or two stay full, the rest degrade to digest lines
    const out = buildTranscript(
      { session: sessionRow(), events, children: [], rawBySeq: new Map() },
      tiny,
    );
    expect(out.compactedTurns).toBeGreaterThanOrEqual(2);
    expect(out.estimatedTokens).toBeLessThanOrEqual(
      tiny + estimateTokens("") + 250,
    );
    expect(out.text).toContain("[compacted by budget]");
    expect(out.text).toContain("task 6"); // newest survives in full
    expect(out.text.indexOf("compacted by budget")).toBeLessThan(
      out.text.indexOf("## Turn t6"),
    );
  });

  test("rolls child sessions up, including nested-subagent counts", () => {
    const text = buildTranscript({
      session: sessionRow(),
      events: [turnStart("t1", "work"), request("t1")],
      children: [child()],
      rawBySeq: new Map(),
    }).text;
    expect(text).toContain("# Subagent sessions (1)");
    expect(text).toContain("child session child1");
    expect(text).toContain("spawns 2 nested subagent(s)");
    expect(text).toContain("Read×12");
    expect(text).toContain("first user message: go fix it");
  });

  test("extractRawEvidence reads Anthropic-style tool_result blocks", () => {
    const found = extractRawEvidence(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_call_id: "x",
                content: [{ type: "text", text: "the actual output" }],
              },
            ],
          },
        ],
      },
      new Set(["x"]),
    );
    expect(found).toEqual(["the actual output"]);
  });

  test("raw evidence passes through extraction unclipped; the transcript clips it", () => {
    const big = "a".repeat(RAW_EVIDENCE_CAP_CHARS * 3);
    const found = extractRawEvidence(
      [{ tool_call_id: "x", content: big }],
      new Set(["x"]),
    );
    // extraction is faithful; the size cap lives in the transcript renderer
    expect(found[0]!.length).toBe(big.length);
    const events = [
      turnStart("t1", "run it"),
      request("t1"),
      call("t1", "x", "Bash"),
      result("t1", "x", false, "boom"),
    ];
    const text = buildTranscript({
      session: sessionRow(),
      events,
      children: [],
      rawBySeq: new Map([
        [events[1]!.event_seq, [{ tool_call_id: "x", content: big }]],
      ]),
    }).text;
    expect(text.length).toBeLessThan(big.length); // clipped head+tail
    expect(text).toContain("[truncated");
  });
});

describe("failureRawSeqs", () => {
  test("picks the last request of each failed turn", () => {
    const events: StoredEvent[] = [];
    for (let i = 1; i <= 6; i++) {
      events.push(turnStart(`t${i}`, `task ${i}`));
      events.push(request(`t${i}`));
      events.push(call(`t${i}`, `c${i}`, "Bash"));
      events.push(result(`t${i}`, `c${i}`, i % 2 === 0)); // t2/t4/t6 fail
      events.push(request(`t${i}`)); // wrap-up request echoes the failure
    }
    const seqs = failureRawSeqs(events);
    expect(seqs).toHaveLength(3);
    // every returned seq is a request event seq in a turn with a failure
    const requestSeqs = new Set(
      events
        .filter((s) => s.event.kind === "model_request")
        .map((s) => s.event_seq),
    );
    for (const s of seqs) expect(requestSeqs.has(s)).toBe(true);
    // and they are the wrap-up requests of exactly the failing turns
    const failingWrap = events.filter(
      (s) => s.event.kind === "model_request" && seqs.includes(s.event_seq),
    );
    expect(failingWrap).toHaveLength(3);
  });

  test("caps enrichment fetches at 12 failed turns", () => {
    const events: StoredEvent[] = [];
    for (let i = 1; i <= 15; i++) {
      events.push(turnStart(`t${i}`, `task ${i}`));
      events.push(request(`t${i}`));
      events.push(call(`t${i}`, `c${i}`, "Bash"));
      events.push(result(`t${i}`, `c${i}`, false));
      events.push(request(`t${i}`));
    }
    expect(failureRawSeqs(events)).toHaveLength(12);
  });
});

// ---- presets & angle validation -------------------------------------------

describe("retrospective presets", () => {
  test("the shipped defaults are five thorough, uniquely-id'd angles", () => {
    expect(DEFAULT_ANGLES).toHaveLength(5);
    const ids = new Set(DEFAULT_ANGLES.map((a) => a.id));
    expect(ids.size).toBe(5);
    expect(ids.has(CUSTOM_ANGLE_ID)).toBe(false);
    for (const angle of DEFAULT_ANGLES) {
      expect(angle.title.length).toBeGreaterThan(2);
      // deliberate verbosity: the prompt text is the whole quality
      expect(angle.prompt.length).toBeGreaterThan(300);
    }
  });

  test("the shared skeleton carries the evidence discipline and output contract", () => {
    expect(RETRO_SYSTEM_CORE).toContain("证据纪律");
    expect(RETRO_SYSTEM_CORE).toContain("严重度");
    expect(RETRO_SYSTEM_CORE).toContain("中文");
  });

  test("parseRetroAngles enforces shape, uniqueness, and the reserved id", () => {
    expect(
      parseRetroAngles([{ id: "a", title: "A", prompt: "p" }]),
    ).toHaveLength(1);
    expect(parseRetroAngles("nope")).toBeNull();
    expect(parseRetroAngles([])).toBeNull();
    expect(
      parseRetroAngles([
        { id: "a", title: "A", prompt: "p" },
        { id: "a", title: "A2", prompt: "p" },
      ]),
    ).toBeNull();
    expect(
      parseRetroAngles([{ id: "custom", title: "C", prompt: "p" }]),
    ).toBeNull();
    expect(
      parseRetroAngles([{ id: "Bad Id", title: "B", prompt: "p" }]),
    ).toBeNull();
    expect(parseRetroAngles([{ id: "ok", title: "", prompt: "p" }])).toBeNull();
    expect(parseRetroAngles([{ id: "ok", title: "T", prompt: "" }])).toBeNull();
  });

  test("effectiveRetroAngles falls back to the defaults on absent or broken stored text", () => {
    expect(effectiveRetroAngles(null)).toEqual(DEFAULT_ANGLES);
    expect(effectiveRetroAngles("")).toEqual(DEFAULT_ANGLES);
    expect(effectiveRetroAngles("not json")).toEqual(DEFAULT_ANGLES);
    expect(effectiveRetroAngles('{"id":"x"}')).toEqual(DEFAULT_ANGLES);
    const stored = JSON.stringify([
      { id: "ops", title: "Ops 视角", prompt: "检视运维习惯" },
    ]);
    expect(effectiveRetroAngles(stored)[0]!.id).toBe("ops");
  });
});
