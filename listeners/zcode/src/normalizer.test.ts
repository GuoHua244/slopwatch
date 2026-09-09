import { describe, expect, test } from "bun:test";
import { isNormalEvent } from "@slopwatch/events";
import {
  eventsFromRecord,
  resolveSessionId,
  sessionIdFromFilename,
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
      expect(isNormalEvent(evts[0])).toBe(true);
    }
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
