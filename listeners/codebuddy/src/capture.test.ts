/**
 * Capture-engine tests on a synthetic but shape-faithful host tree, using
 * REAL message/log bytes from fixtures/history-record.ts. These pin the two
 * behaviours that make this agent's capture different from every other
 * listener: message files are read once (never re-tailed), and a model
 * request waits for token counts that live in another file entirely.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalEvent } from "@slopwatch/events";
import { createCodebuddyCapture } from "./capture";
import {
  conversationIndexPath,
  messagePath,
  workspaceIndexPath,
} from "./paths";
import {
  REAL_CONVERSATION_ID,
  REAL_WORKSPACE_HASH,
  realAssistantMessageJson,
  realConversationIndexJson,
  realToolMessageJson,
  realUsageLogLines,
  realUserMessageJson,
  realWorkspaceIndexJson,
} from "./fixtures/history-record";

const USER = "1fc7b522dffc457486d3a99629366b4b";
const ASSISTANT = "f47957d9eb514aba9c91a6e0cbe0843b";
const TOOL = "0740d14f8f2a44049ccfd79791f4babd";

const tmp = mkdtempSync(join(tmpdir(), "slopwatch-codebuddy-capture-"));
const root = join(tmp, "root");
const convDir = join(
  root,
  "history",
  REAL_WORKSPACE_HASH,
  REAL_CONVERSATION_ID,
);
const logFile = join(tmp, `slopwatch__${REAL_WORKSPACE_HASH}.log`);
const stateFile = join(tmp, "state.json");

const ref = {
  root,
  workspaceHash: REAL_WORKSPACE_HASH,
  conversationId: REAL_CONVERSATION_ID,
};

mkdirSync(join(convDir, "messages"), { recursive: true });
// the workspace-level index supplies the title (the first user message)
writeFileSync(workspaceIndexPath(ref), realWorkspaceIndexJson);
writeFileSync(messagePath(ref, USER), realUserMessageJson);
writeFileSync(messagePath(ref, ASSISTANT), realAssistantMessageJson);
writeFileSync(messagePath(ref, TOOL), realToolMessageJson);

const indexOf = (ids: string[]): string =>
  JSON.stringify({
    messages: ids.map((id) => ({
      id,
      type: "text",
      role: "r",
      isComplete: true,
    })),
    requests: [],
  });

let sequence = 0;
const writeIndex = (ids: string[]): void =>
  writeFileSync(conversationIndexPath(ref), indexOf(ids));

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let clock = 1_000;
const make = (opts: {
  usageLog?: string | null;
  graceMs?: number;
  resolveUsageLog?: () => string | null;
}) =>
  createCodebuddyCapture({
    ref,
    sessionId: REAL_CONVERSATION_ID,
    stateFile: `${stateFile}.${sequence++}`,
    usageLog: opts.usageLog === undefined ? logFile : opts.usageLog,
    resolveUsageLog: opts.resolveUsageLog,
    now: () => clock,
    usageGraceMs: opts.graceMs ?? 45_000,
  });

const kinds = (events: NormalEvent[]): string[] =>
  events.map((e) =>
    "event" in e && typeof e.event === "string"
      ? `${e.kind}:${e.event}`
      : e.kind,
  );

const usageOf = (events: NormalEvent[]): unknown => {
  const request = events.find((e) => e.kind === "model_request");
  return request && "usage" in request ? request.usage : undefined;
};

const durationOf = (events: NormalEvent[]): number => {
  const request = events.find((e) => e.kind === "model_request");
  return request && "duration_ms" in request ? request.duration_ms : -1;
};

const metas = (events: NormalEvent[]): NormalEvent[] =>
  events.filter((e) => e.kind === "session" && e.event === "meta");

beforeEach(() => {
  clock = 1_000;
});

describe("draining a conversation", () => {
  test("the first poll ships the prompt, what it can, and the title — holding the assistant step for its counts", () => {
    writeIndex([USER, ASSISTANT, TOOL]);
    const capture = make({ usageLog: null });
    const events = capture.poll();
    // the assistant row is held whole: call, result and request belong to the
    // same step and must not arrive piecemeal
    expect(kinds(events)).toEqual([
      "turn:start",
      "tool:result",
      "session:meta",
    ]);
    expect(events.filter((e) => e.kind === "model_request")).toHaveLength(0);
    expect((events.at(-1) as { title?: string }).title).toContain(
      "为 slopwatch 新增 CodeBuddy listener",
    );
  });

  test("held steps ship whole on the next poll once usage lands", () => {
    writeIndex([USER, ASSISTANT, TOOL]);
    writeFileSync(logFile, ""); // the counts have not been written yet
    const capture = make({});
    expect(capture.poll().some((e) => e.kind === "model_request")).toBe(false);
    writeFileSync(logFile, `${realUsageLogLines[2]!}\n`);
    const second = capture.poll();
    expect(kinds(second)).toEqual([
      "model_request",
      "tool:call",
      "tool:call",
      "tool:result",
      "tool:result",
    ]);
    expect(usageOf(second)).toEqual({
      input_tokens: 15714,
      output_tokens: 71,
      cache_read_tokens: 12608,
      cache_write_tokens: 0,
      reasoning_tokens: 12,
    });
  });

  test("the duration from the same-millisecond metrics line rides along", () => {
    writeIndex([USER, ASSISTANT, TOOL]);
    writeFileSync(logFile, "");
    const capture = make({});
    capture.poll();
    writeFileSync(
      logFile,
      `${realUsageLogLines[2]!}\n${realUsageLogLines[3]!}\n`,
    );
    expect(durationOf(capture.poll())).toBe(3021);
  });

  test("usage already on disk means no wait at all", () => {
    writeIndex([USER, ASSISTANT, TOOL]);
    writeFileSync(
      logFile,
      `${realUsageLogLines[2]!}\n${realUsageLogLines[3]!}\n`,
    );
    const capture = make({});
    const events = capture.poll();
    expect(usageOf(events)).toEqual({
      input_tokens: 15714,
      output_tokens: 71,
      cache_read_tokens: 12608,
      cache_write_tokens: 0,
      reasoning_tokens: 12,
    });
    expect(durationOf(events)).toBe(3021);
  });

  test("counts that never arrive must not stall the evidence", () => {
    writeIndex([USER, ASSISTANT, TOOL]);
    writeFileSync(logFile, "");
    const capture = make({ graceMs: 5_000 });
    expect(capture.poll().some((e) => e.kind === "model_request")).toBe(false);
    // inside the quiet window the log may still flush the counts — hold
    clock += 6_000;
    expect(capture.poll().some((e) => e.kind === "model_request")).toBe(false);
    // a log quiet for a full window means they are never coming
    clock += 6_000;
    const events = capture.poll();
    expect(events.some((e) => e.kind === "model_request")).toBe(true);
    expect(usageOf(events)).toBeUndefined();
    expect(durationOf(events)).toBe(0);
  });

  test("late counts still attach while the usage log keeps growing", () => {
    writeIndex([USER, ASSISTANT, TOOL]);
    writeFileSync(logFile, "");
    const capture = make({ graceMs: 5_000 });
    capture.poll(); // held
    clock += 8_000; // past the grace — but the log just produced bytes
    writeFileSync(logFile, "unrelated workspace activity\n");
    expect(capture.poll().some((e) => e.kind === "model_request")).toBe(false);
    clock += 3_000; // and there are the counts, with the next flush
    writeFileSync(
      logFile,
      `unrelated workspace activity\n${realUsageLogLines[2]!}\n`,
    );
    const events = capture.poll();
    expect(usageOf(events)).toEqual({
      input_tokens: 15714,
      output_tokens: 71,
      cache_read_tokens: 12608,
      cache_write_tokens: 0,
      reasoning_tokens: 12,
    });
  });

  test("a usage log that only appears later is picked up by the resolver", () => {
    writeIndex([USER, ASSISTANT, TOOL]);
    rmSync(logFile, { force: true }); // the day directory does not exist yet
    let path: string | null = null;
    const capture = make({ usageLog: null, resolveUsageLog: () => path });
    expect(capture.poll().some((e) => e.kind === "model_request")).toBe(false);
    writeFileSync(logFile, `${realUsageLogLines[2]!}\n`);
    path = logFile;
    const events = capture.poll();
    expect(usageOf(events)).toEqual({
      input_tokens: 15714,
      output_tokens: 71,
      cache_read_tokens: 12608,
      cache_write_tokens: 0,
      reasoning_tokens: 12,
    });
  });

  test("teardown releases a held step even if nothing ever lands", () => {
    writeIndex([USER, ASSISTANT, TOOL]);
    writeFileSync(logFile, "");
    const capture = make({});
    expect(capture.poll().some((e) => e.kind === "model_request")).toBe(false);
    expect(
      capture.teardown().filter((e) => e.kind === "model_request"),
    ).toHaveLength(1);
    // and only once — a second teardown must not double ship
    expect(capture.teardown()).toEqual([]);
  });
});

describe("appending to a live conversation", () => {
  test("drained rows are never re-emitted; new rows are", () => {
    writeIndex([USER]);
    writeFileSync(logFile, "");
    const capture = make({});
    expect(kinds(capture.poll())).toEqual(["turn:start", "session:meta"]);

    writeIndex([USER, ASSISTANT, TOOL]);
    clock += 60_000;
    // the tool row ships at once; the assistant step is now waiting on counts
    expect(kinds(capture.poll())).toEqual(["tool:result"]);

    clock += 60_000; // its grace has expired — the whole step ships
    const events = capture.poll();
    expect(
      events.filter((e) => e.kind === "tool" && e.event === "call"),
    ).toHaveLength(2);
    expect(
      events.filter((e) => e.kind === "tool" && e.event === "result"),
    ).toHaveLength(2);
    expect(events.filter((e) => e.kind === "model_request")).toHaveLength(1);
  });

  test("a respawned listener resumes from its sidecar without re-shipping", () => {
    writeIndex([USER, ASSISTANT, TOOL]);
    writeFileSync(
      logFile,
      `${realUsageLogLines[2]!}\n${realUsageLogLines[3]!}\n`,
    );
    const file = `${stateFile}.respawn`;
    const first = createCodebuddyCapture({
      ref,
      sessionId: REAL_CONVERSATION_ID,
      stateFile: file,
      usageLog: logFile,
      now: () => clock,
    });
    const batch = first.poll();
    expect(batch.length).toBeGreaterThan(0);
    // live.ts acks the delivered batch — the respawn test models that, so the
    // title gate is committed before the generation dies
    first.onFlushed(batch);

    const second = createCodebuddyCapture({
      ref,
      sessionId: REAL_CONVERSATION_ID,
      stateFile: file,
      usageLog: logFile,
      now: () => clock,
    });
    expect(second.poll()).toEqual([]);
    expect(second.teardown()).toEqual([]);
  });

  test("counts landing after the row was read still reach it", () => {
    writeIndex([USER, ASSISTANT]);
    writeFileSync(logFile, "");
    const capture = make({ graceMs: 5_000 });
    capture.poll();
    writeFileSync(
      logFile,
      `${realUsageLogLines[2]!}\n${realUsageLogLines[3]!}\n`,
    );
    expect(usageOf(capture.poll())).toEqual({
      input_tokens: 15714,
      output_tokens: 71,
      cache_read_tokens: 12608,
      cache_write_tokens: 0,
      reasoning_tokens: 12,
    });
  });
});

describe("the title gate", () => {
  test("the title ships once, and only the delivery ack commits it", () => {
    writeIndex([USER]);
    writeFileSync(logFile, "");
    const capture = make({});
    const first = capture.poll();
    expect(metas(first)).toHaveLength(1);

    // pending, not committed: another poll must not re-announce
    expect(metas(capture.poll())).toEqual([]);

    capture.onFlushed(first);
    expect(metas(capture.poll())).toEqual([]);
  });

  test("a batch that never shipped leaves the title free to re-announce", () => {
    writeIndex([USER]);
    writeFileSync(logFile, "");
    const capture = make({});
    const first = capture.poll();
    capture.onFlushFailed(first);
    capture.onFlushed(first); // the retry's ack commits it
    expect(metas(capture.poll())).toEqual([]);
  });
});

describe("host behaviour the pin exists for", () => {
  test("a row whose message file is missing waits for it instead of consuming the row", () => {
    writeIndex([USER, "gone-message-id"]);
    writeFileSync(logFile, "");
    const capture = make({});
    const first = capture.poll();
    expect(() => capture.poll()).not.toThrow();
    // the user row shipped; the unreadable row was neither dropped nor counted
    expect(kinds(first)).toEqual(["turn:start", "session:meta"]);
    // when the file lands, the row ships like any other
    writeFileSync(messagePath(ref, "gone-message-id"), realToolMessageJson);
    const events = capture.poll();
    expect(events.some((e) => e.kind === "tool" && e.event === "result")).toBe(
      true,
    );
  });

  test("a corrupt manifest is quarantined, never dropped silently", () => {
    writeFileSync(conversationIndexPath(ref), "{not json");
    writeFileSync(logFile, "");
    const capture = make({});
    const events = capture.poll();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("quarantine");
    writeIndex([USER]);
  });

  test("a shrunk usage log is re-read from the top, and already-shipped rows never return", () => {
    writeIndex([USER, ASSISTANT]);
    writeFileSync(logFile, realUsageLogLines[0]!);
    const capture = make({});
    capture.poll();
    clock += 120_000; // past the quiet window WITHOUT its counts
    expect(capture.poll().some((e) => e.kind === "model_request")).toBe(true);
    // the log rotates/shrinks and grows again — a real thing happens at midnight
    writeFileSync(
      logFile,
      `${realUsageLogLines[2]!}\n${realUsageLogLines[3]!}\n`,
    );
    expect(capture.poll()).toEqual([]);
  });

  test("restored state resumes past its watermark and keeps the open turn", () => {
    const file = `${stateFile}.roundtrip`;
    writeFileSync(
      file,
      JSON.stringify({
        turnId: USER,
        emittedToolResults: [],
        processed: 2,
        usageCursor: 0,
        pending: [],
        titleSent: null,
      }),
    );
    writeIndex([USER, ASSISTANT, TOOL]);
    writeFileSync(logFile, "");
    const capture = createCodebuddyCapture({
      ref,
      sessionId: REAL_CONVERSATION_ID,
      stateFile: file,
      usageLog: null,
      now: () => clock,
    });
    const events = capture.poll();
    // only the third row survives the watermark — and it inherits the turn
    expect(kinds(events)).toEqual(["tool:result", "session:meta"]);
    const result = events[0] as NormalEvent & { tool?: string };
    expect(result.tool).toBe("execute_command");
  });

  test("the real manifest addresses three rows the same way this tree does", () => {
    const parsed = JSON.parse(realConversationIndexJson) as {
      messages: { id: string }[];
    };
    expect(parsed.messages[0]?.id).toBe(USER);
    expect(parsed.messages).toHaveLength(3);
  });
});

describe("sub-agent run adoption", () => {
  const pad = (v: number, n = 2): string => String(v).padStart(n, "0");
  const stampOf = (d: Date): string =>
    `[${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}]`;
  const startLine = (runId: string, stamp: string): string =>
    `${stamp} [Info] [BaseAgent:code-explorer] [${runId}]  notifyAgentStart`;
  const stepLine = (runId: string, msgId: string, stamp: string): string =>
    `${stamp} [Info] [BaseAgent:code-explorer] [${runId}]  notifyStepEnd, step: 1, requestId: ${runId}, messageId: ${msgId}, usage: {"inputTokens":100,"outputTokens":5,"totalTokens":105,"cacheTokens":0,"cachedWriteTokens":0,"cachedMissTokens":0,"lastTokens":105,"credit":0,"thinkingTokens":0}, isMaxTokenLimit: false`;
  const PARENT_RUN = "00592a8d23944ff7b9422c179366547d";

  test("runs from before the session are not adopted; live ones are", () => {
    clock = Date.now();
    writeIndex([USER, ASSISTANT, TOOL]);
    // the fixture conversation starts on 2026-10-08 — a run stamped a week
    // earlier belongs to whatever came before it
    const before = new Date(Date.parse("2026-10-01T12:00:00.000"));
    const live = new Date(Date.now() + 5);
    const oldRun = "6bb8a2b7032c4fb391155571f3d7abf5";
    const liveRun = "697251572984447993675ecbcc3e45f6";
    writeFileSync(
      logFile,
      [
        `${stampOf(live)} [Info] [BaseAgent:craft] [${PARENT_RUN}]  notifyAgentStart`,
        startLine(oldRun, stampOf(before)),
        stepLine(oldRun, "0000000000000000000000000000dead", stampOf(before)),
        startLine(liveRun, stampOf(live)),
        stepLine(liveRun, "0000000000000000000000000000face", stampOf(live)),
      ].join("\n") + "\n",
    );
    const capture = make({});
    const events = capture.poll();
    const childStarts = events.filter(
      (e) =>
        e.kind === "session" && e.event === "start" && "parent_session_id" in e,
    );
    expect(childStarts).toHaveLength(1);
    expect((childStarts[0] as { session_id?: string }).session_id).toBe(
      `sub-${liveRun}`,
    );
    // and the adopted run's counts ride on its request
    const childRequest = events.find(
      (e) => e.kind === "model_request" && e.session_id === `sub-${liveRun}`,
    ) as { usage?: { input_tokens?: number } } | undefined;
    expect(childRequest?.usage?.input_tokens).toBe(100);
  });
});
