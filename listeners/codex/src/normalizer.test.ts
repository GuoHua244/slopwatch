import { describe, expect, test } from "bun:test";
import {
  isNormalEvent,
  type NormalEvent,
  type TurnStartEvent,
} from "@slopwatch/events";
import {
  driftFromRecord,
  eventsFromRecord,
  newTailState,
  realUserPrompt,
  type TailState,
} from "./normalizer";
import {
  agentsMdRecord,
  assistantMessageRecord,
  compactedRecord,
  environmentContextRecord,
  execSessionMetaRecord,
  functionCallOutputRecord,
  functionCallRecord,
  itemCompletedRecord,
  legacyAgentMessageRecord,
  legacyMcpToolCallRecord,
  legacyUserMessageRecord,
  localShellCallRecord,
  markedPromptRecord,
  mixedPromptRecord,
  sessionMetaRecord,
  taskCompleteRecord,
  taskStartedRecord,
  threadSettingsRecord,
  tokenCountOnlyRecord,
  tokenCountRecord,
  tokenUsageRecord,
  turnAbortedRecord,
  turnContextRecord,
  userPromptRecord,
  webSearchCallRecord,
  worldStateRecord,
  CALL_ID,
  TURN_ID,
} from "./fixtures/rollout-record";

/** Feed records through one fresh state, returning all events. */
const run = (
  records: unknown[],
  state: TailState = newTailState(),
): NormalEvent[] =>
  records.flatMap((r) => eventsFromRecord(r, "sess_codex", state));

describe("codex realUserPrompt", () => {
  test("a plain user message is the prompt", () => {
    expect(
      realUserPrompt(
        (userPromptRecord as { payload: Record<string, unknown> }).payload,
      ),
    ).toBe("把 listeners 目录下的测试跑一遍并汇报结果");
  });

  test("environment_context / AGENTS.md wrappers are not prompts", () => {
    expect(
      realUserPrompt(
        (environmentContextRecord as { payload: Record<string, unknown> })
          .payload,
      ),
    ).toBeNull();
    expect(
      realUserPrompt(
        (agentsMdRecord as { payload: Record<string, unknown> }).payload,
      ),
    ).toBeNull();
  });

  test("a marked prompt keeps only the text after the marker", () => {
    expect(
      realUserPrompt(
        (markedPromptRecord as { payload: Record<string, unknown> }).payload,
      ),
    ).toBe("修复 cursor 的缩水重置逻辑");
  });

  test("a mixed message drops wrapper items and keeps the speech item", () => {
    expect(
      realUserPrompt(
        (mixedPromptRecord as { payload: Record<string, unknown> }).payload,
      ),
    ).toBe("看看 CI 为什么红了");
  });
});

describe("codex turn pairing", () => {
  test("prompt record → task_started emits one turn:start with the words", () => {
    const events = run([
      sessionMetaRecord,
      userPromptRecord,
      taskStartedRecord,
    ]);
    const starts = events.filter(
      (e): e is TurnStartEvent => e.kind === "turn" && e.event === "start",
    );
    expect(starts.length).toBe(1);
    expect(starts[0]!.turn_id).toBe(TURN_ID);
    expect(starts[0]!.user_message).toBe(
      "把 listeners 目录下的测试跑一遍并汇报结果",
    );
    // the first real prompt also announces the task preview, once
    const previews = events.filter(
      (e) => e.kind === "session" && e.event === "meta",
    );
    expect(previews.length).toBe(1);
  });

  test("a repeated task_started for the same turn does not re-emit", () => {
    const state = newTailState();
    run([userPromptRecord, taskStartedRecord], state);
    const events = run([taskStartedRecord], state);
    expect(
      events.filter((e) => e.kind === "turn" && e.event === "start").length,
    ).toBe(0);
  });

  test("task_started before the prompt record still pairs (reversed order)", () => {
    const events = run([taskStartedRecord, userPromptRecord]);
    const starts = events.filter(
      (e): e is TurnStartEvent => e.kind === "turn" && e.event === "start",
    );
    expect(starts.length).toBe(1);
    expect(starts[0]!.turn_id).toBe(TURN_ID);
    expect(starts[0]!.user_message).toBe(
      "把 listeners 目录下的测试跑一遍并汇报结果",
    );
  });

  test("a turn that starts with no prompt opens messageless at first activity", () => {
    const events = run([taskStartedRecord, functionCallRecord]);
    const startIndex = events.findIndex(
      (e) => e.kind === "turn" && e.event === "start",
    );
    const callIndex = events.findIndex(
      (e) => e.kind === "tool" && e.event === "call",
    );
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(callIndex).toBeGreaterThan(startIndex);
    const start = events[startIndex] as TurnStartEvent;
    expect(start.turn_id).toBe(TURN_ID);
    expect(start.user_message).toBeUndefined();
  });

  test("task_complete and turn_aborted end a started turn once", () => {
    const state = newTailState();
    run([userPromptRecord, taskStartedRecord], state);
    const ended = run([taskCompleteRecord], state).filter(
      (e) => e.kind === "turn" && e.event === "end",
    );
    expect(ended.length).toBe(1);
    expect(
      run([taskCompleteRecord, turnAbortedRecord], state).filter(
        (e) => e.kind === "turn" && e.event === "end",
      ).length,
    ).toBe(0);
  });
});

describe("codex usage → model_request", () => {
  test("token_usage_record emits the model request with mapped usage", () => {
    const events = run([
      sessionMetaRecord,
      turnContextRecord,
      userPromptRecord,
      taskStartedRecord,
      tokenUsageRecord,
    ]);
    const mr = events.find((e) => e.kind === "model_request");
    expect(isNormalEvent(mr!)).toBe(true);
    if (mr!.kind === "model_request") {
      expect(mr!.provider).toBe("custom");
      expect(mr!.model).toBe("deepseek/deepseek-flash");
      expect(mr!.turn_id).toBe(TURN_ID);
      expect(mr!.request_id).toBe("dafe75a3-8d4f-4b46-ac2b-c09da7ebee95");
      expect(mr!.usage).toEqual({
        input_tokens: 40814,
        cache_read_tokens: 27136,
        cache_write_tokens: 0,
        output_tokens: 258,
        reasoning_tokens: 0,
      });
    }
  });

  test("the paired token_count is skipped once a token_usage_record was seen", () => {
    const events = run([
      sessionMetaRecord,
      turnContextRecord,
      assistantMessageRecord,
      tokenUsageRecord,
      tokenCountRecord,
    ]);
    const requests = events.filter((e) => e.kind === "model_request");
    expect(requests.length).toBe(1);
    // the assistant speech rode the token_usage_record, not the token_count
    expect(
      (requests[0] as Extract<NormalEvent, { kind: "model_request" }>)
        .response_text,
    ).toBe("测试全部通过：normalizer 12 个用例、drift 4 个用例。");
  });

  test("on a 0.147-era file token_count is the only usage source", () => {
    const events = run([
      execSessionMetaRecord,
      turnContextRecord,
      tokenCountOnlyRecord,
    ]);
    const requests = events.filter((e) => e.kind === "model_request");
    expect(requests.length).toBe(1);
    expect(
      (requests[0] as Extract<NormalEvent, { kind: "model_request" }>).usage,
    ).toEqual({
      input_tokens: 1240,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 42,
      reasoning_tokens: 0,
    });
  });

  test("a zero-usage replay and a lower cumulative total are skipped", () => {
    const state = newTailState();
    run([turnContextRecord, tokenUsageRecord], state);
    expect(
      run([tokenUsageRecord], state).filter((e) => e.kind === "model_request")
        .length,
    ).toBe(0);
    // a revert fork replays the prefix with a reset cumulative counter
    const rewound = {
      ...tokenUsageRecord,
      timestamp: "2026-11-18T02:20:59.000Z",
      payload: {
        ...tokenUsageRecord.payload,
        response_id: "rewound-response",
        usage: {
          ...tokenUsageRecord.payload.usage,
          input_tokens: 10,
          total_tokens: 52,
        },
        thread_token_usage: {
          ...tokenUsageRecord.payload.usage,
          total_tokens: 52,
        },
      },
    };
    expect(
      run([rewound], state).filter((e) => e.kind === "model_request").length,
    ).toBe(0);
  });

  test("thread_settings_applied switches the model for later requests", () => {
    const events = run([
      turnContextRecord,
      threadSettingsRecord,
      tokenUsageRecord,
    ]);
    const mr = events.find(
      (e): e is Extract<NormalEvent, { kind: "model_request" }> =>
        e.kind === "model_request",
    );
    expect(mr!.model).toBe("glm-5.3");
  });
});

describe("codex tool calls", () => {
  test("function_call → tool:call with parsed args; output → named result", () => {
    const events = run([
      taskStartedRecord,
      functionCallRecord,
      functionCallOutputRecord,
    ]);
    const call = events.find(
      (e): e is Extract<NormalEvent, { kind: "tool"; event: "call" }> =>
        e.kind === "tool" && e.event === "call",
    );
    expect(isNormalEvent(call!)).toBe(true);
    expect(call!.tool_call_id).toBe(CALL_ID);
    expect(call!.tool).toBe("exec_command");
    expect((call!.args as { cmd: string[] }).cmd).toEqual([
      "bash",
      "-lc",
      "bun test listeners",
    ]);
    const result = events.find(
      (e): e is Extract<NormalEvent, { kind: "tool"; event: "result" }> =>
        e.kind === "tool" && e.event === "result",
    );
    expect(result!.tool_call_id).toBe(CALL_ID);
    expect(result!.tool).toBe("exec_command");
    // function_call_output carries no ok flag
    expect(result!.ok).toBeUndefined();
  });

  test("a replayed call/output pair does not re-emit", () => {
    const state = newTailState();
    run([functionCallRecord, functionCallOutputRecord], state);
    const replayed = run([functionCallRecord, functionCallOutputRecord], state);
    expect(replayed.filter((e) => e.kind === "tool").length).toBe(0);
  });

  test("local_shell_call and web_search_call map to their tool names", () => {
    const events = run([localShellCallRecord, webSearchCallRecord]);
    const calls = events.filter(
      (e): e is Extract<NormalEvent, { kind: "tool"; event: "call" }> =>
        e.kind === "tool" && e.event === "call",
    );
    expect(calls.map((c) => c.tool).sort()).toEqual([
      "local_shell",
      "web_search",
    ]);
  });

  test("legacy mcp_tool_call_end → tool:result with duration and ok", () => {
    const events = run([legacyMcpToolCallRecord]);
    const result = events.find(
      (e): e is Extract<NormalEvent, { kind: "tool"; event: "result" }> =>
        e.kind === "tool" && e.event === "result",
    );
    expect(isNormalEvent(result!)).toBe(true);
    expect(result!.tool).toBe("execute_sql");
    expect(result!.ok).toBe(true);
    expect(result!.duration_ms).toBe(42);
  });
});

describe("codex legacy history_mode", () => {
  test("user_message feeds the turn pairing like a response_item prompt", () => {
    const events = run([legacyUserMessageRecord, taskStartedRecord]);
    const start = events.find(
      (e): e is TurnStartEvent => e.kind === "turn" && e.event === "start",
    );
    expect(start!.user_message).toBe("Reply with OK only.");
  });

  test("agent_message rides the next usage record as response_text", () => {
    const events = run([
      execSessionMetaRecord,
      legacyAgentMessageRecord,
      tokenCountOnlyRecord,
    ]);
    const mr = events.find(
      (e): e is Extract<NormalEvent, { kind: "model_request" }> =>
        e.kind === "model_request",
    );
    expect(mr!.response_text).toBe("OK");
  });
});

describe("codex eventless records", () => {
  test("item_completed, world_state, and compacted produce no events", () => {
    const events = run([
      itemCompletedRecord,
      worldStateRecord,
      compactedRecord as unknown,
    ]);
    expect(events.length).toBe(0);
  });
});

describe("codex manifest", () => {
  test("every emitted event passes the shared guard", () => {
    const events = run([
      sessionMetaRecord,
      userPromptRecord,
      environmentContextRecord,
      taskStartedRecord,
      functionCallRecord,
      functionCallOutputRecord,
      assistantMessageRecord,
      tokenUsageRecord,
      tokenCountRecord,
      taskCompleteRecord,
      legacyMcpToolCallRecord,
      localShellCallRecord,
      webSearchCallRecord,
      threadSettingsRecord,
    ]);
    expect(events.length).toBeGreaterThan(8);
    for (const event of events) expect(isNormalEvent(event)).toBe(true);
  });

  test("drift reasons quarantine unknown shapes", () => {
    expect(driftFromRecord({ type: "mystery_record", payload: {} })).toBe(
      "unknown record type: mystery_record",
    );
    expect(driftFromRecord({ noType: true })).toBe(
      "record without a type field",
    );
    expect(driftFromRecord("a string")).toBe("record is not an object");
    expect(
      driftFromRecord({ type: "session_meta", payload: { cwd: "D:\\x" } }),
    ).toBe("session_meta without payload.id");
    expect(
      driftFromRecord({
        type: "response_item",
        payload: { type: "brand_new_item" },
      }),
    ).toBe("unknown response_item payload type: brand_new_item");
    expect(
      driftFromRecord({
        type: "event_msg",
        payload: { type: "brand_new_event" },
      }),
    ).toBe("unknown event_msg payload type: brand_new_event");
    // known bookkeeping records stay quiet
    expect(driftFromRecord(worldStateRecord)).toBeNull();
    expect(driftFromRecord(itemCompletedRecord)).toBeNull();
    expect(driftFromRecord(sessionMetaRecord)).toBeNull();
  });
});
