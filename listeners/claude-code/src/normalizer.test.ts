import { describe, expect, test } from "bun:test";
import {
  isNormalEvent,
  type AttachmentEvent,
  type NormalEvent,
} from "@slopwatch/events";
import {
  eventsFromRecord,
  flushOpenMessage,
  isRealPromptRecord,
  metaFromRecord,
  newTailState,
  promptTextFromRecord,
  restoreTailState,
  serializeTailState,
} from "./normalizer";
import {
  aiTitleRecord,
  assistantTextRecord,
  assistantThinkingRecord,
  assistantToolUseRecord,
  commandEchoRecord,
  compactedRecord,
  compactedUnflaggedRecord,
  erroredToolResultRecord,
  imagePromptRecord,
  interleavedToolResultRecord,
  legacyPromptRecord,
  metaPromptRecord,
  nextMessageRecord,
  promptRecord,
  sidechainAssistantRecord,
  summaryRecord,
  taskNotificationRecord,
  toolResultImageRecord,
  TINY_PNG_BASE64,
} from "./fixtures/transcript-record";

const sessionId = "sess_claude-demo";

const newSink = (): { seen: Set<string> } => ({ seen: new Set<string>() });

const kindsOf = (events: NormalEvent[]): string[] =>
  events.map((e) => `${e.kind}:${"event" in e ? e.event : "*"}`);

describe("real-prompt detection", () => {
  test("a typed prompt is real; command echoes and notifications are not", () => {
    expect(isRealPromptRecord(promptRecord)).toBe(true);
    expect(isRealPromptRecord(legacyPromptRecord)).toBe(true);
    expect(isRealPromptRecord(commandEchoRecord)).toBe(false);
    expect(isRealPromptRecord(taskNotificationRecord)).toBe(false);
    expect(isRealPromptRecord(metaPromptRecord)).toBe(false);
    expect(isRealPromptRecord(interleavedToolResultRecord)).toBe(false);
    // a compaction continuation is never a human prompt
    expect(isRealPromptRecord(compactedRecord)).toBe(false);
    expect(isRealPromptRecord(compactedUnflaggedRecord)).toBe(false);
  });

  test("legacy builds (no origin field) decide by text alone", () => {
    const echo = {
      ...legacyPromptRecord,
      uuid: "u-legacy-echo",
      message: {
        role: "user",
        content: "<command-name>/exit</command-name>",
      },
    };
    expect(isRealPromptRecord(echo)).toBe(false);
  });
});

describe("compaction continuation (same session, visibly marked)", () => {
  test("the continuation opens a `[compacted]`-marked turn on the same session", () => {
    for (const record of [compactedRecord, compactedUnflaggedRecord]) {
      const state = newTailState();
      eventsFromRecord(promptRecord, sessionId, state); // turn u-0001
      eventsFromRecord(assistantThinkingRecord, sessionId, state); // open msg
      const events = eventsFromRecord(record, sessionId, state);
      const kinds = kindsOf(events);
      // held-back request flushes, then the marked turn opens
      expect(kinds.indexOf("model_request:*")).toBeLessThan(
        kinds.indexOf("turn:start"),
      );
      const start = events.find((e) => e.kind === "turn");
      if (start!.kind === "turn" && start!.event === "start") {
        expect(start!.turn_id).toBe(record.uuid);
        expect(start!.user_message!.startsWith("[compacted] ")).toBe(true);
        expect(start!.user_message).toContain("summarized below");
      }
      expect(state.turnId).toBe(record.uuid);
      // no task preview from a compaction — previews belong to human prompts
      expect(
        events.find((e) => e.kind === "session" && e.event === "meta"),
      ).toBeUndefined();
      // the next message's request attributes to the compaction turn
      eventsFromRecord(nextMessageRecord, sessionId, state); // opens msg_02ABC
      const closer = eventsFromRecord(
        {
          ...nextMessageRecord,
          uuid: "a-close",
          message: { ...nextMessageRecord.message, id: "msg_03DEF" },
        },
        sessionId,
        state,
      );
      const mr = closer.find((e) => e.kind === "model_request");
      if (mr!.kind === "model_request") {
        expect(mr!.turn_id).toBe(record.uuid);
      }
    }
  });
});

describe("turn lifecycle", () => {
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

  test("the first real prompt becomes the task preview, once — and a command echo never does", () => {
    const state = newTailState();
    // sessions often open with /clear — the preview must survive it
    const noise = eventsFromRecord(commandEchoRecord, sessionId, state);
    expect(noise.find((e) => e.kind === "turn")).toBeUndefined();
    expect(noise.find((e) => e.kind === "session")).toBeUndefined();

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

  test("an image-only prompt opens a turn without user_message, with refs", () => {
    const state = newTailState();
    const imageOnly = {
      ...imagePromptRecord,
      uuid: "u-img-only",
      message: {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: TINY_PNG_BASE64,
            },
          },
        ],
      },
    };
    const events = eventsFromRecord(imageOnly, sessionId, state, newSink());
    const start = events.find((e) => e.kind === "turn");
    expect(start).toBeDefined();
    if (start!.kind === "turn" && start!.event === "start") {
      expect(start!.user_message).toBeUndefined();
      expect(start!.images).toHaveLength(1);
      expect(start!.images![0]!.n).toBe(1);
    }
    const attachment = events.find((e) => e.kind === "attachment");
    expect(attachment).toBeDefined();
    expect(isNormalEvent(attachment!)).toBe(true);
  });
});

describe("one model request across its per-block records", () => {
  test("tool calls ship immediately; the model_request waits for the close", () => {
    const state = newTailState();
    eventsFromRecord(promptRecord, sessionId, state); // turn u-0001

    const thinking = eventsFromRecord(
      assistantThinkingRecord,
      sessionId,
      state,
    );
    expect(thinking).toEqual([]); // no prose, no tools, not closed yet

    const text = eventsFromRecord(assistantTextRecord, sessionId, state);
    expect(text).toEqual([]); // prose accumulates until the close

    const tools = eventsFromRecord(assistantToolUseRecord, sessionId, state);
    // a tool_result between the message's own records must not split it
    const inter = eventsFromRecord(
      interleavedToolResultRecord,
      sessionId,
      state,
    );
    expect(inter.filter((e) => e.kind === "model_request")).toHaveLength(0);
    expect(state.open).not.toBeNull();

    const calls = [...tools, ...inter].filter(
      (e) => e.kind === "tool" && e.event === "call",
    );
    expect(calls).toHaveLength(1);
    expect(isNormalEvent(calls[0]!)).toBe(true);

    // a different message.id closes the group
    const next = eventsFromRecord(nextMessageRecord, sessionId, state);
    const flushed = next.filter((e) => e.kind === "model_request");
    expect(flushed).toHaveLength(1);
    expect(isNormalEvent(flushed[0]!)).toBe(true);
    const mr = flushed[0]!;
    if (mr.kind === "model_request") {
      expect(mr.provider).toBe("anthropic");
      expect(mr.model).toBe("claude-sonnet-4-5");
      expect(mr.turn_id).toBe("u-0001");
      // duration = prompt → first block, not inter-block streaming gaps
      expect(mr.duration_ms).toBe(12_500);
      expect(mr.usage).toEqual({
        input_tokens: 1200,
        output_tokens: 88,
        cache_read_tokens: 5600,
        cache_write_tokens: 340,
      });
      // prose from the text record, not just the first one
      expect(mr.response_text).toBe("我先看一下目录。");
      expect(mr.raw).toBeDefined();
    }
    expect(state.seenMessageIds.has("msg_01XYZ")).toBe(true);
  });

  test("the open message flushes on teardown with what it has", () => {
    const state = newTailState();
    eventsFromRecord(promptRecord, sessionId, state);
    eventsFromRecord(assistantThinkingRecord, sessionId, state);
    eventsFromRecord(assistantTextRecord, sessionId, state);
    expect(state.open).not.toBeNull();
    const flushed = flushOpenMessage(state, sessionId);
    expect(flushed).not.toBeNull();
    if (flushed!.kind === "model_request") {
      expect(flushed!.response_text).toBe("我先看一下目录。");
      expect(flushed!.turn_id).toBe("u-0001");
    }
    expect(state.open).toBeNull();
    expect(flushOpenMessage(state, sessionId)).toBeNull();
  });

  test("response_text keeps markdown newlines within and across blocks", () => {
    const state = newTailState();
    eventsFromRecord(promptRecord, sessionId, state);
    const streamed = {
      ...assistantTextRecord,
      uuid: "a-0009",
      message: {
        ...assistantTextRecord.message,
        content: [
          {
            type: "text",
            text: "## 报告 **范围**:`repo`\n\n### packages/\n\n| a | b |\n|---|---|",
          },
          { type: "text", text: "第二段。" },
        ],
      },
    };
    eventsFromRecord(streamed, sessionId, state);
    const flushed = flushOpenMessage(state, sessionId);
    if (flushed === null || flushed.kind !== "model_request")
      throw new Error("no model_request flushed");
    expect(flushed.response_text).toBe(
      "## 报告 **范围**:`repo`\n\n### packages/\n\n| a | b |\n|---|---|\n\n第二段。",
    );
  });

  test("a real prompt also closes the open message", () => {
    const state = newTailState();
    eventsFromRecord(promptRecord, sessionId, state);
    eventsFromRecord(assistantThinkingRecord, sessionId, state);
    const second = eventsFromRecord(promptRecord, sessionId, state);
    const kinds = kindsOf(second);
    expect(kinds.indexOf("model_request:*")).toBeLessThan(
      kinds.indexOf("turn:start"),
    );
  });

  test("an already-flushed message re-read yields no duplicate request", () => {
    const state = newTailState();
    eventsFromRecord(promptRecord, sessionId, state);
    eventsFromRecord(assistantToolUseRecord, sessionId, state);
    eventsFromRecord(nextMessageRecord, sessionId, state); // closes + flushes
    // cursor loss re-read: same message again — request stays single
    const again = eventsFromRecord(assistantToolUseRecord, sessionId, state);
    expect(again.filter((e) => e.kind === "model_request")).toHaveLength(0);
    expect(
      again.filter((e) => e.kind === "tool" && e.event === "call"),
    ).toHaveLength(0); // block id deduped too
  });

  test("a standalone assistant record with no message.id still produces a request", () => {
    const state = newTailState();
    const synthetic = {
      ...assistantTextRecord,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "no id" }],
      },
    };
    eventsFromRecord(synthetic, sessionId, state);
    const flushed = flushOpenMessage(state, sessionId);
    expect(flushed).not.toBeNull();
    expect(flushed!.kind).toBe("model_request");
  });
});

describe("tool results", () => {
  test("a result names itself through the earlier call", () => {
    const state = newTailState();
    eventsFromRecord(assistantToolUseRecord, sessionId, state);
    const events = eventsFromRecord(
      interleavedToolResultRecord,
      sessionId,
      state,
    );
    const result = events.find((e) => e.kind === "tool");
    expect(result).toBeDefined();
    if (result!.kind === "tool" && result!.event === "result") {
      expect(result!.tool_call_id).toBe("toolu_01A");
      expect(result!.tool).toBe("Bash");
      expect(result!.ok).toBe(true);
    }
  });

  test("an errored result carries its text", () => {
    const state = newTailState();
    eventsFromRecord(assistantToolUseRecord, sessionId, state);
    const events = eventsFromRecord(erroredToolResultRecord, sessionId, state);
    const result = events.find((e) => e.kind === "tool");
    if (result!.kind === "tool" && result!.event === "result") {
      expect(result!.ok).toBe(false);
      expect(result!.error).toBe("command not found: nosuchbin");
    }
  });

  test("a result with an unknown call id degrades to 'unknown', never throws", () => {
    const state = newTailState();
    const events = eventsFromRecord(
      interleavedToolResultRecord,
      sessionId,
      state,
    );
    const result = events.find((e) => e.kind === "tool");
    if (result!.kind === "tool") expect(result!.tool).toBe("unknown");
  });

  test("a tool result carrying an image ships the attachment and the sha", () => {
    const state = newTailState();
    eventsFromRecord(assistantToolUseRecord, sessionId, state);
    const events = eventsFromRecord(
      toolResultImageRecord,
      sessionId,
      state,
      newSink(),
    );
    const attachments = events.filter((e) => e.kind === "attachment");
    expect(attachments).toHaveLength(1);
    expect(isNormalEvent(attachments[0]!)).toBe(true);
    // attachment precedes its referencing result
    expect(kindsOf(events)[0]).toBe("attachment:*");
    const result = events.find((e) => e.kind === "tool");
    if (result!.kind === "tool" && result!.event === "result") {
      expect(result!.images).toHaveLength(1);
    }
  });
});

describe("inline image capture", () => {
  test("re-pasted identical images dedupe to one attachment, two refs", () => {
    const state = newTailState();
    const sink = newSink();
    const first = eventsFromRecord(imagePromptRecord, sessionId, state, sink);
    const second = eventsFromRecord(imagePromptRecord, sessionId, state, sink);
    expect(
      [...first, ...second].filter((e) => e.kind === "attachment"),
    ).toHaveLength(1);
    // both turns still carry the ref — the dashboard shows each paste
    expect(first.find((e) => e.kind === "turn")).toBeDefined();
    expect(second.find((e) => e.kind === "turn")).toBeDefined();
  });

  test("an oversized image block is skipped entirely, not shipped", () => {
    const state = newTailState();
    // ~4.5MB decoded — past the 4MiB attachment cap
    const oversized = {
      ...imagePromptRecord,
      uuid: "u-huge",
      message: {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "A".repeat(6_000_000),
            },
          },
        ],
      },
    };
    const events = eventsFromRecord(oversized, sessionId, state, newSink());
    expect(events.filter((e) => e.kind === "attachment")).toHaveLength(0);
    // the turn still opens — a skipped attachment is never a lost turn
    expect(events.find((e) => e.kind === "turn")).toBeDefined();
  });
});

describe("session meta", () => {
  test("a legacy summary record becomes the session title", () => {
    const meta = metaFromRecord(summaryRecord, sessionId);
    expect(meta).toBeDefined();
    expect(isNormalEvent(meta!)).toBe(true);
    if (meta!.kind === "session" && meta!.event === "meta") {
      expect(meta!.title).toBe("梳理 slopwatch 仓库结构");
    }
  });

  test("a modern ai-title record becomes the session title", () => {
    const meta = metaFromRecord(aiTitleRecord, sessionId);
    expect(meta).toBeDefined();
    if (meta!.kind === "session" && meta!.event === "meta") {
      expect(meta!.title).toBe("repo 结构梳理");
    }
  });

  test("non-title records yield nothing", () => {
    expect(metaFromRecord(promptRecord, sessionId)).toBeNull();
    expect(metaFromRecord(assistantTextRecord, sessionId)).toBeNull();
    expect(metaFromRecord({ type: "summary" }, sessionId)).toBeNull();
    expect(metaFromRecord({ type: "ai-title" }, sessionId)).toBeNull();
  });
});

describe("sidechain records", () => {
  test("the normalizer itself does not filter — the adapter guards the primary", () => {
    const state = newTailState();
    const events = eventsFromRecord(sidechainAssistantRecord, sessionId, state);
    // the record still normalizes; live.ts's adapter drops it for the parent
    expect(flushOpenMessage(state, sessionId)).not.toBeNull();
  });
});

describe("tail state persistence", () => {
  test("serialize → restore keeps turn attribution and dedup sets", () => {
    const state = newTailState();
    eventsFromRecord(promptRecord, sessionId, state);
    eventsFromRecord(assistantThinkingRecord, sessionId, state);
    eventsFromRecord(assistantToolUseRecord, sessionId, state);

    const restored = restoreTailState(
      JSON.parse(JSON.stringify(serializeTailState(state))),
    )!;
    expect(restored.turnId).toBe("u-0001");
    expect(restored.seenToolUseIds.has("toolu_01A")).toBe(true);
    expect(restored.open?.messageId).toBe("msg_01XYZ");
    expect(restored.toolNames.get("toolu_01A")).toBe("Bash");

    // the restored state continues seamlessly: the result names its call
    const events = eventsFromRecord(
      interleavedToolResultRecord,
      sessionId,
      restored,
    );
    const result = events.find((e) => e.kind === "tool");
    if (result!.kind === "tool") expect(result!.tool).toBe("Bash");
  });

  test("a corrupt snapshot restores as null (fresh state)", () => {
    expect(restoreTailState({ version: 3 })).toBeNull(); // a future version
    expect(restoreTailState("nope")).toBeNull();
    expect(restoreTailState(null)).toBeNull();
  });

  test("a version-1 snapshot restores with the legacy title gate", () => {
    const restored = restoreTailState({ version: 1, titleSent: "kept" })!;
    expect(restored.titleSent).toBe("kept");
    expect(restored.titleSentLegacy).toBe(true); // may be the truncated form
    // a v1 snapshot without a title has nothing to gate
    expect(restoreTailState({ version: 1 })!.titleSentLegacy).toBe(false);
    // a v2 snapshot's flag is read as written
    expect(
      restoreTailState({
        version: 2,
        titleSent: "kept",
        titleSentLegacy: true,
      })!.titleSentLegacy,
    ).toBe(true);
    expect(restoreTailState({ version: 2 })!.titleSentLegacy).toBe(false);
  });

  test("promptTextFromRecord reads string and block content", () => {
    expect(promptTextFromRecord(promptRecord)).toBe("帮我看看这个仓库的结构");
    expect(promptTextFromRecord(imagePromptRecord)).toBe(
      "这张截图里是什么问题？",
    );
    expect(promptTextFromRecord({ type: "user" })).toBe("");
  });
});
