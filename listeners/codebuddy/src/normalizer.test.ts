/**
 * Normalizer tests — real messages in, expected `NormalEvent`s out. Two rules
 * dominate: an assistant message is one Model request (its token counts come
 * from outside the transcript), and a tool result that arrives twice is
 * recorded once.
 */
import { describe, expect, test } from "bun:test";
import type {
  ModelRequestEvent,
  ToolCallEvent,
  ToolResultEvent,
  TurnStartEvent,
} from "@slopwatch/events";
import {
  AGENT,
  PROVIDER,
  newTailState,
  normalizeMessage,
  trimTailState,
  TOOL_RESULT_MEMORY,
} from "./normalizer";
import { parseMessageFile } from "./transcript";
import {
  failedToolMessageJson,
  realAssistantMessageJson,
  realToolMessageJson,
  realUserMessageJson,
} from "./fixtures/history-record";

const SESSION = "775cc5f8f8604b798be88bbf9bc3c06d";

const message = (json: string) => {
  const parsed = parseMessageFile(json);
  if (!parsed.ok) throw new Error(`fixture broken: ${parsed.reason}`);
  return parsed.message;
};

describe("user messages open a turn", () => {
  test("the user message is the prompt and its id becomes the turn id", () => {
    const state = newTailState();
    const events = normalizeMessage({
      message: message(realUserMessageJson),
      sessionId: SESSION,
      state,
    });
    expect(events).toHaveLength(1);
    const turn = events[0] as TurnStartEvent;
    expect(turn.kind).toBe("turn");
    expect(turn.event).toBe("start");
    expect(turn.turn_id).toBe("1fc7b522dffc457486d3a99629366b4b");
    expect(turn.user_message).toContain("为 slopwatch 新增 CodeBuddy listener");
    expect(turn.agent).toBe(AGENT);
    expect(turn.session_id).toBe(SESSION);
    expect(turn.occurred_at).toBe("2026-10-08T10:37:59.000Z");
    // the following assistant messages hang off this turn
    expect(state.turnId).toBe(turn.turn_id);
  });

  test("captured prompt prose is bounded (unbounded raw never reaches Postgres)", () => {
    const long = {
      ...message(realUserMessageJson),
      text: "x".repeat(10_000),
    };
    const events = normalizeMessage({
      message: long,
      sessionId: SESSION,
      state: newTailState(),
    });
    expect((events[0] as TurnStartEvent).user_message).toHaveLength(2000);
  });
});

describe("assistant messages are one model request plus their tool calls", () => {
  test("usage from the log attaches and both tool calls are announced", () => {
    const state = newTailState();
    state.turnId = "turn-1";
    const events = normalizeMessage({
      message: message(realAssistantMessageJson),
      sessionId: SESSION,
      state,
      usage: {
        occurredAt: "2026-10-08T10:38:04.276Z",
        step: 2,
        requestId: "00592a8d23944ff7b9422c179366547d",
        messageId: "f47957d9eb514aba9c91a6e0cbe0843b",
        durationMs: 3021,
        usage: { input_tokens: 15714, output_tokens: 71 },
      },
    });
    const request = events[0] as ModelRequestEvent;
    expect(request.kind).toBe("model_request");
    expect(request.provider).toBe(PROVIDER);
    expect(request.model).toBe("hy4-preview-f");
    expect(request.duration_ms).toBe(3021);
    expect(request.turn_id).toBe("turn-1");
    expect(request.request_id).toBe("00592a8d23944ff7b9422c179366547d");
    expect(request.usage).toEqual({ input_tokens: 15714, output_tokens: 71 });

    const calls = events.filter((e) => e.kind === "tool" && e.event === "call");
    expect(calls.map((c) => (c as ToolCallEvent).tool)).toEqual([
      "list_dir",
      "read_file",
    ]);
    expect((calls[0] as ToolCallEvent).args).toEqual({
      target_directory: "d:/studySpace/slopwatch",
    });
    expect((calls[0] as ToolCallEvent).tool_call_id).toBe(
      "call_3abe7045bac04b89b2032e5e",
    );
  });

  test("the assistant's own inline results become tool:result events", () => {
    const events = normalizeMessage({
      message: message(realAssistantMessageJson),
      sessionId: SESSION,
      state: newTailState(),
    });
    const results = events.filter(
      (e) => e.kind === "tool" && e.event === "result",
    ) as ToolResultEvent[];
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.tool).sort()).toEqual([
      "list_dir",
      "read_file",
    ]);
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.error).toBeUndefined();
  });

  test("without usage the model request still ships, with zero duration", () => {
    const events = normalizeMessage({
      message: message(realAssistantMessageJson),
      sessionId: SESSION,
      state: newTailState(),
    });
    const request = events[0] as ModelRequestEvent;
    expect(request.duration_ms).toBe(0);
    expect(request.usage).toBeUndefined();
  });

  test("the model falls back to its name when no id is present", () => {
    const events = normalizeMessage({
      message: { ...message(realAssistantMessageJson), modelId: null },
      sessionId: SESSION,
      state: newTailState(),
    });
    expect((events[0] as ModelRequestEvent).model).toBe("Hy4 preview");
  });
});

describe("tool results are emitted once", () => {
  test("a tool-role message repeating an inline result does not double it", () => {
    const state = newTailState();
    normalizeMessage({
      message: message(realAssistantMessageJson),
      sessionId: SESSION,
      state,
    });
    const seen = state.emittedToolResults;
    expect(seen).toContain("call_3abe7045bac04b89b2032e5e");

    // now the very same run arrives again as a tool-role message
    const events = normalizeMessage({
      message: {
        ...message(realToolMessageJson),
        toolResults: [
          {
            toolCallId: "call_3abe7045bac04b89b2032e5e",
            toolName: "list_dir",
            result: {},
          },
        ],
      },
      sessionId: SESSION,
      state,
    });
    expect(events).toEqual([]);
  });

  test("a failed run carries ok=false and its error text", () => {
    const events = normalizeMessage({
      message: message(failedToolMessageJson),
      sessionId: SESSION,
      state: newTailState(),
    });
    const result = events[0] as ToolResultEvent;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("command not permitted");
  });

  test("a result with no success/status flags ships without a verdict", () => {
    const events = normalizeMessage({
      message: {
        ...message(realToolMessageJson),
        toolResults: [
          { toolCallId: "c1", toolName: "execute_command", result: null },
        ],
      },
      sessionId: SESSION,
      state: newTailState(),
    });
    expect((events[0] as ToolResultEvent).ok).toBeUndefined();
  });
});

describe("tail state", () => {
  test("the dedup set is bounded so a long session cannot grow without limit", () => {
    const state = trimTailState({
      turnId: "t",
      emittedToolResults: Array.from(
        { length: TOOL_RESULT_MEMORY + 10 },
        (_, i) => `call-${i}`,
      ),
    });
    expect(state.emittedToolResults).toHaveLength(TOOL_RESULT_MEMORY);
    expect(state.emittedToolResults.at(-1)).toBe(
      `call-${TOOL_RESULT_MEMORY + 9}`,
    );
    // the newest ids are the ones worth keeping — they are the live ones
    expect(state.emittedToolResults[0]).toBe("call-10");
  });

  test("an unknown role produces no events and no state damage", () => {
    const state = newTailState();
    state.turnId = "keep-me";
    const events = normalizeMessage({
      message: { ...message(realUserMessageJson), role: "system" },
      sessionId: SESSION,
      state,
    });
    expect(events).toEqual([]);
    expect(state.turnId).toBe("keep-me");
  });
});
