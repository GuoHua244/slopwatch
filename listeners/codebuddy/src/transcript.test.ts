/**
 * Parser tests: every case drives REAL captured bytes from
 * fixtures/history-record.ts (research/codebuddy-capture-surfaces.md §2).
 * The host's history format is undocumented, so these tests are the drift
 * alarm — a shape change must fail here rather than silently drop evidence.
 */
import { describe, expect, test } from "bun:test";
import {
  conversationTitle,
  newIndexMessages,
  parseConversationIndex,
  parseMessageFile,
  parseWorkspaceIndex,
} from "./transcript";
import {
  emptyConversationIndexJson,
  failedToolMessageJson,
  realAssistantMessageJson,
  realConversationIndexJson,
  realToolMessageJson,
  realUserMessageJson,
  realWorkspaceIndexJson,
  REAL_CONVERSATION_ID,
} from "./fixtures/history-record";

describe("parseConversationIndex", () => {
  test("reads the real manifest into ordered rows and request groups", () => {
    const parsed = parseConversationIndex(realConversationIndexJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(parsed.value.messages.map((m) => m.isComplete)).toEqual([
      true,
      false,
      true,
    ]);
    expect(parsed.value.messages[0]?.id).toBe(
      "1fc7b522dffc457486d3a99629366b4b",
    );
    expect(parsed.value.requests).toHaveLength(1);
    // one request groups the user prompt, its assistant answer and the tool row
    expect(parsed.value.requests[0]?.messages).toHaveLength(3);
    expect(parsed.value.requests[0]?.state).toBe("running");
  });

  test("a conversation that has not been spoken to yet is empty, not broken", () => {
    const parsed = parseConversationIndex(emptyConversationIndexJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.messages).toEqual([]);
    expect(parsed.value.requests).toEqual([]);
  });

  test("a corrupt or shape-drifted manifest is refused with a reason", () => {
    expect(parseConversationIndex("{not json").ok).toBe(false);
    const noMessages = parseConversationIndex('{"requests":[]}');
    expect(noMessages.ok).toBe(false);
    if (!noMessages.ok)
      expect(noMessages.reason).toContain("no messages array");
  });

  test("rows without an id are skipped — they address no message file", () => {
    const parsed = parseConversationIndex(
      '{"messages":[{"role":"user"},{"id":"keep","role":"user","type":"text","isComplete":true}]}',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.messages.map((m) => m.id)).toEqual(["keep"]);
  });
});

describe("newIndexMessages", () => {
  test("returns only rows past the watermark", () => {
    const parsed = parseConversationIndex(realConversationIndexJson);
    if (!parsed.ok) throw new Error("fixture must parse");
    expect(newIndexMessages(parsed.value, 0)).toHaveLength(3);
    expect(newIndexMessages(parsed.value, 2).map((m) => m.role)).toEqual([
      "tool",
    ]);
    expect(newIndexMessages(parsed.value, 3)).toEqual([]);
  });
});

describe("parseMessageFile", () => {
  test("reads the double-encoded user message", () => {
    const parsed = parseMessageFile(realUserMessageJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const m = parsed.message;
    expect(m.role).toBe("user");
    expect(m.id).toBe("1fc7b522dffc457486d3a99629366b4b");
    expect(m.text).toContain("任务：为 slopwatch 新增 CodeBuddy listener");
    expect(m.requestId).toBe("00592a8d23944ff7b9422c179366547d");
    expect(m.modelId).toBe("hy4-preview-f");
    expect(m.traceId).not.toBeNull();
    expect(m.isHelperMessage).toBe(false);
    expect(m.createdAt).toBe("2026-10-08T10:37:59.000Z");
  });

  test("separates reasoning from speech and exposes tool calls + inline results", () => {
    const parsed = parseMessageFile(realAssistantMessageJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const m = parsed.message;
    expect(m.role).toBe("assistant");
    expect(m.reasoning).toBe("Let me explore the repo structure.");
    expect(m.toolCalls.map((c) => c.toolName)).toEqual([
      "list_dir",
      "read_file",
    ]);
    expect(m.toolCalls[0]?.args).toEqual({
      target_directory: "d:/studySpace/slopwatch",
    });
    // the results ride the assistant's own extra.toolStatus
    expect(Object.keys(m.toolStatus)).toHaveLength(2);
    expect(m.toolStatus["call_3abe7045bac04b89b2032e5e"]?.status).toBe(
      "executed",
    );
    expect(m.toolResults).toEqual([]);
  });

  test("reads a tool-role message's results", () => {
    const parsed = parseMessageFile(realToolMessageJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.message.role).toBe("tool");
    expect(parsed.message.toolResults).toHaveLength(1);
    expect(parsed.message.toolResults[0]?.toolName).toBe("execute_command");
  });

  test("a failed tool run keeps an error-shaped result (normalizer decides ok)", () => {
    const parsed = parseMessageFile(failedToolMessageJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = parsed.message.toolResults[0]?.result as Record<
      string,
      unknown
    >;
    expect(result.success).toBe(false);
    expect(result.error).toBe("command not permitted");
  });

  test("a message with no id or no role is refused, not guessed at", () => {
    expect(parseMessageFile('{"role":"user"}').ok).toBe(false);
    expect(parseMessageFile('{"id":"a"}').ok).toBe(false);
    expect(parseMessageFile("nope").ok).toBe(false);
  });

  test("a broken inner payload parses with empty speech instead of throwing", () => {
    const parsed = parseMessageFile(
      '{"id":"x","role":"assistant","message":"{oops","extra":"{oops","createdAt":"2026-01-01T00:00:00.000Z"}',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.message.text).toBe("");
    expect(parsed.message.requestId).toBeNull();
  });
});

describe("parseWorkspaceIndex", () => {
  test("the conversation list supplies the only title this agent offers", () => {
    const index = parseWorkspaceIndex(realWorkspaceIndexJson);
    expect(index).not.toBeNull();
    expect(index?.current).toBe(REAL_CONVERSATION_ID);
    // `name` is the first user message verbatim
    expect(conversationTitle(index, REAL_CONVERSATION_ID)).toContain(
      "任务：为 slopwatch 新增 CodeBuddy listener",
    );
    expect(conversationTitle(index, "no-such-conversation")).toBeNull();
  });

  test("a missing or unreadable list is null, never an empty-but-truthy object", () => {
    expect(parseWorkspaceIndex("{oops")).toBeNull();
    expect(parseWorkspaceIndex('{"conversations":"nope"}')).toBeNull();
  });
});
