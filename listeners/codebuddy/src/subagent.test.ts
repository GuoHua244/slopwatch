/**
 * Sub-agent capture tests, against a run this workspace actually produced
 * (2026-10-09): a `Task` tool call started a `BaseAgent:code-explorer` run
 * with its own `requestId`, logged twelve `notifyStepEnd` usage lines, and
 * wrote not one message into the parent conversation's manifest. The log is
 * therefore the only place a sub-agent's tokens exist — and the only way to
 * attribute them without inventing evidence.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodebuddyCapture } from "./capture";
import {
  CHILD_IDLE_MS,
  childSessionId,
  isChildRun,
  modelByPrefix,
  parseAgentRuns,
} from "./subagent";
import { conversationIndexPath, messagePath } from "./paths";
import { usageFromLogText } from "./usage";
import {
  PRIMARY_RUN,
  REAL_CONVERSATION_ID,
  REAL_WORKSPACE_HASH,
  realAgentStartLines,
  realAssistantMessageJson,
  realSubagentUsageLogLines,
  realUserMessageJson,
  REQUEST,
  SUBAGENT_RUN,
} from "./fixtures/history-record";

const USER = "1fc7b522dffc457486d3a99629366b4b";
const ASSISTANT = "f47957d9eb514aba9c91a6e0cbe0843b";

describe("agent runs in the log", () => {
  test("notifyAgentStart names each run and its agent type", () => {
    const runs = parseAgentRuns(realAgentStartLines.join("\n"));
    expect(runs.map((run) => run.runId)).toEqual([PRIMARY_RUN, SUBAGENT_RUN]);
    expect(runs.map((run) => run.agentType)).toEqual([
      "craft",
      "code-explorer",
    ]);
    // the log clock is the machine's own local time — compare it that way
    expect(Date.parse(runs[0]!.startedAt)).toBe(
      Date.parse("2026-10-09T12:21:29.062"),
    );
    expect(Date.parse(runs[1]!.startedAt)).toBe(
      Date.parse("2026-10-09T12:21:50.539"),
    );
  });

  test("a run with no notifyAgentStart line is unknown, not guessed at", () => {
    expect(parseAgentRuns(realSubagentUsageLogLines.join("\n"))).toEqual([]);
  });

  test("the model a sub-agent ran on is read from its own init line", () => {
    const models = modelByPrefix(realSubagentUsageLogLines.join("\n"));
    expect(models.get("code-explorer")).toBe("hy4-preview-f");
  });

  test("sub-agent steps carry their run id and their agent prefix", () => {
    const records = usageFromLogText(realSubagentUsageLogLines.join("\n"));
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.requestId).toBe(SUBAGENT_RUN);
      expect(record.agentPrefix).toBe("code-explorer");
    }
    expect(records[0]?.usage).toEqual({
      input_tokens: 3346,
      output_tokens: 92,
      cache_read_tokens: 2944,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
    });
  });
});

describe("child-session selection", () => {
  test("a run is a child unless its id is one of the parent's own requests", () => {
    const runs = parseAgentRuns(realAgentStartLines.join("\n"));
    const parentRunIds = new Set([PRIMARY_RUN]);
    const children = runs.filter((run) => isChildRun(run, parentRunIds));
    expect(children).toHaveLength(1);
    expect(children[0]?.agentType).toBe("code-explorer");
    // the parent's own run is never a child of itself
    expect(isChildRun(runs[0]!, parentRunIds)).toBe(false);
  });

  test("a child session id is derived from the run id", () => {
    expect(childSessionId(SUBAGENT_RUN)).toBe(`sub-${SUBAGENT_RUN}`);
  });
});

// --- capture level ---------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), "slopwatch-codebuddy-subagent-"));
const root = join(tmp, "root");
const ref = {
  root,
  workspaceHash: REAL_WORKSPACE_HASH,
  conversationId: REAL_CONVERSATION_ID,
};
const logFile = join(tmp, "sub.log");
const stateFile = join(tmp, "state");

mkdirSync(
  join(root, "history", REAL_WORKSPACE_HASH, REAL_CONVERSATION_ID, "messages"),
  {
    recursive: true,
  },
);
writeFileSync(messagePath(ref, USER), realUserMessageJson);
writeFileSync(messagePath(ref, ASSISTANT), realAssistantMessageJson);
writeFileSync(
  conversationIndexPath(ref),
  JSON.stringify({
    messages: [
      { id: USER, type: "text", role: "user", isComplete: true },
      { id: ASSISTANT, type: "text", role: "assistant", isComplete: true },
    ],
    requests: [],
  }),
);
// the parent's own usage: its requestId is the one the parent's messages
// carry, and its messageId IS in the manifest above
writeFileSync(
  logFile,
  [
    `[2026/10/9 12:21:29.062] [Info] [BaseAgent:craft] [${REQUEST}]  notifyAgentStart`,
    `[2026/10/9 12:21:40.000] [Info] [BaseAgent:craft] [${REQUEST}]  notifyStepEnd, step: 1, requestId: ${REQUEST}, messageId: ${ASSISTANT}, usage: {"inputTokens":100,"outputTokens":10}, isMaxTokenLimit: false`,
    // the sub-agent's own run start, then its steps
    realAgentStartLines[1]!,
    ...realSubagentUsageLogLines,
  ].join("\n") + "\n",
);

// the same clock the log lines are written in: both are the machine's local
// time, parsed by the same rule the listener uses
let clock = Date.parse("2026-10-09T12:22:30.000");
let sequence = 0;
const make = () =>
  createCodebuddyCapture({
    ref,
    sessionId: REAL_CONVERSATION_ID,
    stateFile: `${stateFile}.${sequence++}`,
    usageLog: logFile,
    cwd: "d:\\studySpace\\slopwatch",
    hostname: "test-host",
    now: () => clock,
    usageGraceMs: 1_000,
  });

const kinds = (events: { kind: string; event?: string }[]): string[] =>
  events.map((e) => (e.event ? `${e.kind}:${e.event}` : e.kind));

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  clock = Date.parse("2026-10-09T12:22:30.000");
});

describe("capture of a sub-agent run", () => {
  test("the run ships as a child session: start, its requests, and an end", () => {
    const capture = make();
    const first = capture.poll();
    const childId = childSessionId(SUBAGENT_RUN);
    const starts = first.filter(
      (e) =>
        e.kind === "session" && e.event === "start" && e.session_id === childId,
    );
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      parent_session_id: REAL_CONVERSATION_ID,
      cwd: "d:\\studySpace\\slopwatch",
      hostname: "test-host",
    });
    const requests = first.filter(
      (e) => e.kind === "model_request" && e.session_id === childId,
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      model: "hy4-preview-f",
      usage: { input_tokens: 3346, output_tokens: 92 },
    });
    // the ↳ marker is how the dashboard knows the row is a sub-agent
    const meta = first.find(
      (e) =>
        e.kind === "session" && e.event === "meta" && e.session_id === childId,
    ) as { title?: string } | undefined;
    expect(meta?.title).toBe("↳ code-explorer");

    // a quiet run ends itself rather than hanging open forever
    clock += CHILD_IDLE_MS + 1_000;
    const second = capture.poll();
    const ends = second.filter(
      (e) =>
        e.kind === "session" && e.event === "end" && e.session_id === childId,
    );
    expect(ends).toHaveLength(1);
    expect((ends[0] as { reason?: string }).reason).toBe("idle-timeout");
  });

  test("the parent's own steps never become a child session", () => {
    const capture = make();
    const events = capture.poll();
    const childStarts = events.filter(
      (e) =>
        e.kind === "session" &&
        e.event === "start" &&
        e.session_id !== REAL_CONVERSATION_ID,
    );
    expect(childStarts).toHaveLength(1);
    expect(childStarts[0]?.session_id).toBe(childSessionId(SUBAGENT_RUN));
  });

  test("a respawned listener does not re-ship the child's requests", () => {
    const capture = make();
    const first = capture.poll();
    expect(first.length).toBeGreaterThan(0);
    const file = `${stateFile}.respawn`;
    const again = () =>
      createCodebuddyCapture({
        ref,
        sessionId: REAL_CONVERSATION_ID,
        stateFile: file,
        usageLog: logFile,
        cwd: "d:\\studySpace\\slopwatch",
        hostname: "test-host",
        now: () => clock,
        usageGraceMs: 1_000,
      });
    const second = again();
    second.poll();
    const third = again();
    const events = third.poll();
    expect(
      events.filter(
        (e) =>
          e.kind === "model_request" && e.session_id !== REAL_CONVERSATION_ID,
      ),
    ).toEqual([]);
  });

  test("teardown closes a run that is still open", () => {
    const capture = make();
    capture.poll();
    const childId = childSessionId(SUBAGENT_RUN);
    const ends = capture
      .teardown()
      .filter(
        (e) =>
          e.kind === "session" && e.event === "end" && e.session_id === childId,
      );
    expect(ends).toHaveLength(1);
    expect((ends[0] as { reason?: string }).reason).toBe("listener-end");
    // and only once
    expect(
      capture
        .teardown()
        .filter(
          (e) =>
            e.kind === "session" &&
            e.event === "end" &&
            e.session_id === childId,
        ),
    ).toEqual([]);
  });

  test("a sub-agent run that logged no step at all is not a session", () => {
    const quietLog = join(tmp, "quiet.log");
    writeFileSync(
      quietLog,
      [
        `[2026/10/9 12:21:29.062] [Info] [BaseAgent:craft] [${REQUEST}]  notifyAgentStart`,
        `[2026/10/9 12:21:40.000] [Info] [BaseAgent:craft] [${REQUEST}]  notifyStepEnd, step: 1, requestId: ${REQUEST}, messageId: ${ASSISTANT}, usage: {"inputTokens":100,"outputTokens":10}, isMaxTokenLimit: false`,
        realAgentStartLines[1]!,
      ].join("\n") + "\n",
    );
    const capture = createCodebuddyCapture({
      ref,
      sessionId: REAL_CONVERSATION_ID,
      stateFile: `${stateFile}.quiet`,
      usageLog: quietLog,
      cwd: "d:\\studySpace\\slopwatch",
      hostname: "test-host",
      now: () => clock,
      usageGraceMs: 1_000,
    });
    const events = capture.poll();
    expect(events.filter((e) => e.session_id !== REAL_CONVERSATION_ID)).toEqual(
      [],
    );
    expect(kinds(events)).toContain("model_request");
  });
});
