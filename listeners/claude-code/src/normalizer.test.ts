import { describe, expect, test } from "bun:test";
import { isNormalEvent } from "@slopwatch/events";
import { eventsFromRecord, metaFromRecord, newTailState } from "./normalizer";
import {
  assistantDuplicateRecord,
  assistantRecord,
  metaPromptRecord,
  promptRecord,
  summaryRecord,
  toolResultRecord,
} from "./fixtures/transcript-record";

const sessionId = "sess_claude-demo";

describe("eventsFromRecord — user records", () => {
  test("a real prompt opens a turn and carries the user message", () => {
    const state = newTailState();
    const events = eventsFromRecord(promptRecord, sessionId, state);
    const start = events.find((e) => e.kind === "turn");
    expect(start).toBeDefined();
    expect(isNormalEvent(start!)).toBe(true);
    if (start!.kind === "turn" && start!.event === "start") {
      expect(start!.turn_id).toBe("u-0001");
      expect(start!.user_message).toBe("帮我看看这个仓库的结构");
    }
    expect(state.turnId).toBe("u-0001");
  });

  test("the first real prompt also becomes the task preview, once", () => {
    const state = newTailState();
    const first = eventsFromRecord(promptRecord, sessionId, state);
    const preview = first.find(
      (e) => e.kind === "session" && e.event === "meta",
    );
    expect(preview).toBeDefined();
    if (preview!.kind === "session")
      expect(preview!.task_preview).toBe("帮我看看这个仓库的结构");

    const second = eventsFromRecord(promptRecord, sessionId, state);
    expect(
      second.find((e) => e.kind === "session" && e.event === "meta"),
    ).toBeUndefined();
  });

  test("meta-injected user records open no turn", () => {
    const state = newTailState();
    const events = eventsFromRecord(metaPromptRecord, sessionId, state);
    expect(events.find((e) => e.kind === "turn")).toBeUndefined();
  });
});

describe("eventsFromRecord — assistant records", () => {
  test("emits a model_request with mapped usage and turn linkage", () => {
    const state = newTailState();
    eventsFromRecord(promptRecord, sessionId, state); // opens turn u-0001
    const events = eventsFromRecord(assistantRecord, sessionId, state);
    const mr = events.find((e) => e.kind === "model_request");
    expect(mr).toBeDefined();
    expect(isNormalEvent(mr!)).toBe(true);
    if (mr!.kind === "model_request") {
      expect(mr!.provider).toBe("anthropic");
      expect(mr!.model).toBe("claude-sonnet-4-5");
      expect(mr!.request_id).toBe("req_01ABC");
      expect(mr!.turn_id).toBe("u-0001");
      // duration = delta to the previous record's timestamp
      expect(mr!.duration_ms).toBe(12500);
      expect(mr!.usage).toEqual({
        input_tokens: 1200,
        output_tokens: 88,
        cache_read_tokens: 5600,
        cache_write_tokens: 340,
      });
    }
  });

  test("emits a tool call per tool_use block and remembers its name", () => {
    const state = newTailState();
    const events = eventsFromRecord(assistantRecord, sessionId, state);
    const call = events.find((e) => e.kind === "tool");
    expect(call).toBeDefined();
    if (call!.kind === "tool" && call!.event === "call") {
      expect(call!.tool_call_id).toBe("toolu_01A");
      expect(call!.tool).toBe("Bash");
      expect(call!.args).toEqual({ command: "ls", description: "List files" });
    }
    // the follow-up result resolves the tool name through the call
    const results = eventsFromRecord(toolResultRecord, sessionId, state);
    const result = results.find((e) => e.kind === "tool");
    expect(result).toBeDefined();
    if (result!.kind === "tool" && result!.event === "result") {
      expect(result!.tool_call_id).toBe("toolu_01A");
      expect(result!.tool).toBe("Bash");
      expect(result!.ok).toBe(true);
    }
  });

  test("a repeated message.id does not duplicate the model_request", () => {
    const state = newTailState();
    eventsFromRecord(promptRecord, sessionId, state);
    const once = eventsFromRecord(assistantRecord, sessionId, state);
    const twice = eventsFromRecord(assistantDuplicateRecord, sessionId, state);
    expect(once.filter((e) => e.kind === "model_request")).toHaveLength(1);
    expect(twice.filter((e) => e.kind === "model_request")).toHaveLength(0);
    expect(
      twice.filter((e) => e.kind === "tool" && e.event === "call"),
    ).toHaveLength(0);
  });
});

describe("eventsFromRecord — duration grounding", () => {
  test("the first record has zero duration (no previous timestamp)", () => {
    const state = newTailState();
    const events = eventsFromRecord(assistantRecord, sessionId, state);
    const mr = events.find((e) => e.kind === "model_request");
    if (mr!.kind === "model_request") expect(mr!.duration_ms).toBe(0);
  });
});

describe("metaFromRecord — summary records", () => {
  test("a summary record becomes the session title", () => {
    const meta = metaFromRecord(summaryRecord, sessionId);
    expect(meta).toBeDefined();
    expect(isNormalEvent(meta!)).toBe(true);
    if (meta!.kind === "session" && meta!.event === "meta") {
      expect(meta!.title).toBe("梳理 slopwatch 仓库结构");
    }
  });

  test("non-summary records yield nothing", () => {
    expect(metaFromRecord(promptRecord, sessionId)).toBeNull();
    expect(metaFromRecord(assistantRecord, sessionId)).toBeNull();
    expect(metaFromRecord({ type: "summary" }, sessionId)).toBeNull();
  });
});
