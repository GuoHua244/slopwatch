import { describe, expect, test } from "bun:test";
import { isNormalEvent } from "@slopwatch/events";
import {
  eventsFromRecord,
  metaFromRecord,
  resolveSessionId,
  sessionIdFromFilename,
  taskPreviewFromRecord,
  toolResultsFromRecord,
  turnStartFromRecord,
} from "./normalizer";
import {
  mainTurnRecord,
  noResponseRecord,
  titleRecord,
} from "./fixtures/rollout-record";

describe("sessionIdFromFilename", () => {
  test("extracts the sess_-prefixed id from a main-session rollout file", () => {
    expect(sessionIdFromFilename("model-io-sess_6a73fab1-1402.jsonl")).toBe(
      "sess_6a73fab1-1402",
    );
  });

  test("extracts a subagent session id", () => {
    expect(
      sessionIdFromFilename("model-io-sess_subagent_agent_0fea.jsonl"),
    ).toBe("sess_subagent_agent_0fea");
  });

  test("returns null for unrelated files", () => {
    expect(sessionIdFromFilename("db.sqlite")).toBeNull();
    expect(sessionIdFromFilename("model-io-sess_abc.txt")).toBeNull();
  });
});

describe("resolveSessionId", () => {
  test("record sessionId wins; filename is the fallback", () => {
    expect(
      resolveSessionId(
        { sessionId: "sess_in_record" },
        "model-io-sess_from_file.jsonl",
      ),
    ).toBe("sess_in_record");
    expect(resolveSessionId({}, "model-io-sess_from_file.jsonl")).toBe(
      "sess_from_file",
    );
    expect(resolveSessionId({}, null)).toBeNull();
  });
});

describe("eventsFromRecord", () => {
  const events = eventsFromRecord(mainTurnRecord, "sess_demo");

  test("emits a valid model_request with mapped usage and turn linkage", () => {
    const mr = events.find((e) => e.kind === "model_request");
    expect(mr).toBeDefined();
    expect(isNormalEvent(mr!)).toBe(true);
    if (mr!.kind === "model_request") {
      expect(mr!.occurred_at).toBe("2026-09-09T10:23:30.610Z"); // startedAt, not completedAt
      expect(mr!.duration_ms).toBe(3640);
      expect(mr!.provider).toBe("builtin:bigmodel-coding-plan");
      expect(mr!.model).toBe("GLM-5.3-Flash");
      expect(mr!.request_id).toBe("req_demo-0001");
      expect(mr!.turn_id).toBe("turn_demo-1");
      expect(mr!.usage).toEqual({
        input_tokens: 237,
        output_tokens: 131,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      });
      expect(mr!.response_text).toBe("Spawning a subagent for that.");
    }
  });

  test("emits a valid tool call event per response.toolCalls entry", () => {
    const tc = events.find((e) => e.kind === "tool");
    expect(tc).toBeDefined();
    expect(isNormalEvent(tc!)).toBe(true);
    if (tc!.kind === "tool" && tc!.event === "call") {
      expect(tc!.tool_call_id).toBe("tc_demo-1");
      expect(tc!.tool).toBe("Agent");
      expect(tc!.args).toEqual({ prompt: "demo" });
      expect(tc!.occurred_at).toBe("2026-09-09T10:23:34.250Z"); // completedAt
    }
  });

  test("record without a response still yields the model_request", () => {
    const evts = eventsFromRecord(noResponseRecord, "sess_demo");
    expect(evts).toHaveLength(1);
    expect(evts[0]!.kind).toBe("model_request");
    expect(isNormalEvent(evts[0])).toBe(true);
  });

  test("title-generation records have no turn_id but stay valid", () => {
    const evts = eventsFromRecord(titleRecord, "sess_demo");
    expect(evts).toHaveLength(1);
    if (evts[0]!.kind === "model_request") {
      expect(evts[0]!.turn_id).toBeUndefined();
      // a title payload is metadata, not agent speech
      expect(evts[0]!.response_text).toBeUndefined();
      expect(isNormalEvent(evts[0])).toBe(true);
    }
  });

  test("tool results ride on the next request's messages, deduped", () => {
    const recordWithResult = {
      ...mainTurnRecord,
      requestId: "req_demo-0003",
      response: { ...mainTurnRecord.response, toolCalls: undefined },
      request: {
        messages: [
          { role: "user", content: "go" },
          {
            role: "tool",
            toolCallId: "tc_demo-1",
            toolName: "Agent",
            content: "subagent finished",
          },
          {
            role: "tool",
            toolCallId: "tc_bad",
            toolName: "Bash",
            content: "exit 1",
            isError: true,
          },
        ],
      },
    };
    const seen = new Set<string>();
    const first = toolResultsFromRecord(recordWithResult, "sess_demo", seen);
    expect(first).toHaveLength(2);
    expect(isNormalEvent(first[0]!)).toBe(true);
    expect(first[0]).toMatchObject({
      kind: "tool",
      event: "result",
      tool_call_id: "tc_demo-1",
      tool: "Agent",
      ok: true,
    });
    expect(first[1]).toMatchObject({
      kind: "tool",
      event: "result",
      tool_call_id: "tc_bad",
      tool: "Bash",
      ok: false,
      error: "exit 1",
    });
    // the same results echo in every later record — emitted once only
    const again = toolResultsFromRecord(recordWithResult, "sess_demo", seen);
    expect(again).toHaveLength(0);
  });

  test("skips garbage and non-model_io record types", () => {
    expect(eventsFromRecord(null, "s")).toEqual([]);
    expect(eventsFromRecord({}, "s")).toEqual([]);
    expect(eventsFromRecord("line", "s")).toEqual([]);
    expect(
      eventsFromRecord({ ...mainTurnRecord, type: "future_record_type" }, "s"),
    ).toEqual([]);
    expect(
      eventsFromRecord({ ...mainTurnRecord, model: undefined }, "s"),
    ).toEqual([]);
  });
});

describe("metaFromRecord (session title)", () => {
  test("extracts the title from a session_title record's JSON response text", () => {
    const meta = metaFromRecord(titleRecord, "sess_demo");
    expect(meta?.kind).toBe("session");
    expect(meta?.event).toBe("meta");
    expect(meta?.title).toBe("介绍一下 slopwatch");
    expect(isNormalEvent(meta!)).toBe(true);
  });

  test("falls back to the raw text when it is not JSON", () => {
    const rec = {
      ...titleRecord,
      response: { ...(titleRecord.response as object), text: "plain title" },
    };
    expect(metaFromRecord(rec, "s")?.title).toBe("plain title");
  });

  test("returns null for non-title records and garbage", () => {
    expect(metaFromRecord(mainTurnRecord, "s")).toBeNull();
    expect(metaFromRecord(null, "s")).toBeNull();
    expect(
      metaFromRecord({ ...titleRecord, response: undefined }, "s"),
    ).toBeNull();
  });
});

describe("taskPreviewFromRecord (first-turn task preview)", () => {
  test("takes the first real user message of a main_turn record", () => {
    const meta = taskPreviewFromRecord(mainTurnRecord, "sess_demo");
    expect(meta?.event).toBe("meta");
    expect(meta?.task_preview).toContain("介绍一下 slopwatch");
    expect(isNormalEvent(meta!)).toBe(true);
  });

  test("strips injected context blocks from block-array user messages", () => {
    const rec = {
      ...mainTurnRecord,
      request: {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: '<in-app-browser-context source="ambient">noise</in-app-browser-context>',
              },
              { type: "text", text: "8787我已经停掉了，你先把8788也停掉吧" },
            ],
          },
        ],
      },
    };
    expect(taskPreviewFromRecord(rec, "s")?.task_preview).toBe(
      "8787我已经停掉了，你先把8788也停掉吧",
    );
  });

  test("string content with a leading system block keeps the text after it", () => {
    const rec = {
      ...mainTurnRecord,
      request: {
        messages: [
          {
            role: "user",
            content:
              "<system-reminder>meta noise</system-reminder>\n\n## My request for ZCode:\n继续 M5 吧",
          },
        ],
      },
    };
    const preview = taskPreviewFromRecord(rec, "s")?.task_preview;
    expect(preview).toContain("继续 M5 吧");
    expect(preview).not.toContain("##");
  });

  test("real speech containing '>' after the block run is not truncated", () => {
    const rec = {
      ...mainTurnRecord,
      request: {
        messages: [
          {
            role: "user",
            content:
              "<system-reminder>meta</system-reminder>\n\n把 a => b 改成 arrow 函数，然后 x > y 时报错",
          },
        ],
      },
    };
    const preview = taskPreviewFromRecord(rec, "s")?.task_preview;
    expect(preview).toContain("a => b");
    expect(preview).toContain("x > y");
    expect(preview).not.toContain("meta");
  });

  test("skips user messages that are pure injection blocks", () => {
    const rec = {
      ...mainTurnRecord,
      request: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "<tool-result>noise</tool-result>" },
            ],
          },
          { role: "user", content: "真实的第二句任务" },
        ],
      },
    };
    expect(taskPreviewFromRecord(rec, "s")?.task_preview).toBe(
      "真实的第二句任务",
    );
  });

  test("joins array-block content", () => {
    const rec = {
      ...mainTurnRecord,
      request: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "fix " },
              { type: "text", text: "the bug" },
            ],
          },
        ],
      },
    };
    expect(taskPreviewFromRecord(rec, "s")?.task_preview).toBe("fix the bug");
  });

  test("returns null without a user message or outside main_turn", () => {
    expect(
      taskPreviewFromRecord(
        {
          ...mainTurnRecord,
          request: { messages: [{ role: "assistant", content: "hi" }] },
        },
        "s",
      ),
    ).toBeNull();
    expect(taskPreviewFromRecord(titleRecord, "s")).toBeNull();
  });
});

describe("turnStartFromRecord (per-turn user message)", () => {
  test("emits one turn:start with the turn's last real user message", () => {
    const seen = new Set<string>();
    const event = turnStartFromRecord(mainTurnRecord, "sess_demo", seen);
    expect(event?.kind).toBe("turn");
    expect(event?.event).toBe("start");
    expect(event?.turn_id).toBe("turn_demo-1");
    expect(event?.user_message).toContain("介绍一下 slopwatch");
    expect(event?.occurred_at).toBe(mainTurnRecord.startedAt);
    expect(isNormalEvent(event!)).toBe(true);
  });

  test("dedupes by turn_id via the caller-owned set", () => {
    const seen = new Set<string>();
    expect(turnStartFromRecord(mainTurnRecord, "s", seen)).not.toBeNull();
    expect(turnStartFromRecord(mainTurnRecord, "s", seen)).toBeNull();
    // a fresh set (new file generation) emits again
    expect(turnStartFromRecord(mainTurnRecord, "s", new Set())).not.toBeNull();
  });

  test("takes the LAST real user message so later turns carry their own words", () => {
    const rec = {
      ...mainTurnRecord,
      turnId: "turn_demo-2",
      request: {
        messages: [
          { role: "user", content: "first task" },
          { role: "assistant", content: "done" },
          { role: "user", content: "now fix the bug" },
        ],
      },
    };
    expect(turnStartFromRecord(rec, "s", new Set())?.user_message).toBe(
      "now fix the bug",
    );
  });

  test("emits without user_message when the turn has none, and ignores non-model_io records", () => {
    const seen = new Set<string>();
    expect(
      turnStartFromRecord(
        {
          ...mainTurnRecord,
          turnId: "turn_demo-3",
          request: { messages: [{ role: "assistant", content: "hi" }] },
        },
        "s",
        seen,
      )?.user_message,
    ).toBeUndefined();
    expect(turnStartFromRecord(titleRecord, "s", seen)).toBeNull();
    expect(turnStartFromRecord(null, "s", seen)).toBeNull();
  });
});
