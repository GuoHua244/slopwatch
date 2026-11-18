import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  NormalEvent,
  SessionEndEvent,
  SessionMetaEvent,
  SessionStartEvent,
} from "@slopwatch/events";
import {
  assistantMessageRecord,
  functionCallOutputRecord,
  functionCallRecord,
  sessionMetaRecord,
  subagentMetaRecord,
  taskCompleteRecord,
  taskStartedRecord,
  tokenUsageRecord,
  turnContextRecord,
  userPromptRecord,
  SESSION_ID,
  TURN_ID,
} from "./fixtures/rollout-record";

// Runs the real live.ts against a temp rollout and a fake server. Covers the
// full-turn event sequence, the re-attach path (cursor resume + restored
// tool names), and the subagent child claim.

const received: NormalEvent[][] = [];
const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/healthz") return new Response("ok");
    // the fold gate probes credential status on every end — these fixtures
    // exercise the unconfigured path
    if (path === "/summary/llm") return Response.json({ configured: false });
    const body = (await req.json()) as { events: NormalEvent[] };
    received.push(body.events);
    return Response.json({ accepted: body.events.length });
  },
});

const dir = mkdtempSync(join(tmpdir(), "slopwatch-codex-live-"));
const home = join(dir, "home");
const rollout = join(dir, `rollout-2026-11-18T19-08-15-${SESSION_ID}.jsonl`);
const CHILD_ID = "01a1ee58-9ab2-7c31-8e44-3d6b52f10a77";
const childRollout = join(dir, `rollout-2026-11-18T19-30-00-${CHILD_ID}.jsonl`);

const spawnLive = async (file: string, sessionId: string): Promise<void> => {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "live.ts"),
      "--file",
      file,
      "--session-id",
      sessionId,
      "--cwd",
      dir,
      "--idle-ms",
      "300",
      "--max-lifetime-ms",
      "4000",
      "--server-url",
      `http://127.0.0.1:${server.port}`,
      "--token",
      "test-token",
    ],
    // isolate the cursor/state dir so the second spawn takes the re-attach
    // path against persisted sidecars
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`live.ts exited ${code}: ${stderr}`);
};

const flat = (): NormalEvent[] => received.flat();

describe("codex live.ts", () => {
  test("a full turn ships as lifecycle markers, request, and tools", async () => {
    writeFileSync(
      rollout,
      [
        sessionMetaRecord,
        turnContextRecord,
        userPromptRecord,
        taskStartedRecord,
        functionCallRecord,
        assistantMessageRecord,
        tokenUsageRecord,
        taskCompleteRecord,
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    await spawnLive(rollout, SESSION_ID);

    const events = flat();
    expect(events.length).toBeGreaterThan(6);
    // every event the server received is a valid NormalEvent
    for (const event of events) expect(event.agent).toBe("codex");

    const start = events.find(
      (e) => e.kind === "session" && e.event === "start",
    );
    expect(start).toBeDefined();
    if (start?.kind === "session") expect(start.cwd).toBe(dir);

    const preview = events.find(
      (e) => e.kind === "session" && e.event === "meta",
    );
    expect(
      preview?.kind === "session" &&
        preview.task_preview?.includes("把 listeners 目录"),
    ).toBe(true);

    const turnStart = events.find(
      (e) => e.kind === "turn" && e.event === "start",
    );
    expect(turnStart?.kind === "turn" && turnStart.user_message).toContain(
      "把 listeners 目录下的测试跑一遍",
    );

    const call = events.find((e) => e.kind === "tool" && e.event === "call");
    expect(call?.kind === "tool" && call.tool).toBe("exec_command");

    const mr = events.find((e) => e.kind === "model_request");
    expect(mr?.kind === "model_request" && mr.usage?.input_tokens).toBe(40814);
    expect(
      mr?.kind === "model_request" &&
        mr.response_text?.includes("测试全部通过"),
    ).toBe(true);

    const turnEnd = events.find((e) => e.kind === "turn" && e.event === "end");
    expect(turnEnd?.kind === "turn" && turnEnd.turn_id).toBe(TURN_ID);

    const end = events.find((e) => e.kind === "session" && e.event === "end");
    expect(end).toBeDefined();
  }, 30000);

  test("re-attach resumes from the cursor with restored tool names", async () => {
    received.length = 0;
    // the call above shipped in generation 1; only the output is new —
    // it must be named via the restored toolNames map, and the call must
    // not re-ship (cursor past it)
    appendFileSync(rollout, `${JSON.stringify(functionCallOutputRecord)}\n`);
    await spawnLive(rollout, SESSION_ID);

    const events = flat();
    const startCount = events.filter(
      (e) => e.kind === "session" && e.event === "start",
    ).length;
    expect(startCount).toBe(1); // re-attach re-asserts session:start
    expect(events.filter((e) => e.kind === "model_request").length).toBe(0); // cursor: generation 1's usage is not re-shipped
    expect(
      events.filter((e) => e.kind === "tool" && e.event === "call").length,
    ).toBe(0);
    const result = events.find(
      (e): e is Extract<NormalEvent, { kind: "tool" }> =>
        e.kind === "tool" && e.event === "result",
    );
    expect(result).toBeDefined();
    expect(result!.tool).toBe("exec_command");
  }, 30000);

  test("a subagent rollout in the same date dir is claimed as a child session", async () => {
    received.length = 0;
    writeFileSync(
      childRollout,
      [subagentMetaRecord, taskStartedRecord, tokenUsageRecord]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    // the parent rollout must exist for the child scan (dirname scope)
    await spawnLive(rollout, SESSION_ID);

    const events = flat();
    const childStart = events.find(
      (e): e is SessionStartEvent =>
        e.kind === "session" &&
        e.event === "start" &&
        e.session_id === CHILD_ID,
    );
    expect(childStart).toBeDefined();
    expect(childStart!.parent_session_id).toBe(SESSION_ID);
    expect(childStart!.spawned_by_turn_id).toBe(TURN_ID);

    const childRequest = events.find(
      (e): e is Extract<NormalEvent, { kind: "model_request" }> =>
        e.kind === "model_request" && e.session_id === CHILD_ID,
    );
    expect(childRequest).toBeDefined();
    expect(childRequest!.turn_id).toBe(TURN_ID);

    const childTitle = events.find(
      (e): e is SessionMetaEvent =>
        e.kind === "session" && e.event === "meta" && e.session_id === CHILD_ID,
    );
    expect(childTitle && childTitle.title?.startsWith("↳ ")).toBe(true);

    const childEnd = events.find(
      (e): e is SessionEndEvent =>
        e.kind === "session" && e.event === "end" && e.session_id === CHILD_ID,
    );
    expect(childEnd).toBeDefined();
  }, 30000);

  test("cleanup", () => {
    server.stop(true);
  });
});
