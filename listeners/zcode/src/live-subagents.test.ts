import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalEvent } from "@slopwatch/events";
import {
  foreignSubagentRecord,
  mainTurnRecord,
  secondSubagentRecord,
  subagentRecord,
} from "./fixtures/rollout-record";

// Runs the real live.ts against a rollout directory that also holds subagent
// files. ZCode writes each subagent's traffic to its own
// model-io-sess_subagent_agent_<uuid>.jsonl and deletes it at session end, so
// live tail is the only capture path. The claim key is the traceId: a
// subagent record's traceId equals its parent session's, so a concurrently
// open second main session never adopts the wrong file.

const received: NormalEvent[][] = [];
const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/healthz") return new Response("ok");
    if (path === "/summary/llm") return Response.json({ configured: false });
    const body = (await req.json()) as { events: NormalEvent[] };
    received.push(body.events);
    return Response.json({ accepted: body.events.length });
  },
});

const dir = mkdtempSync(join(tmpdir(), "slopwatch-zcode-subagents-"));
const home = join(dir, "home");
const mainSessionId = "sess_subagents-live-test";
const mainFile = join(dir, "model-io-sess_subagents-live-test.jsonl");
const childFile = join(dir, "model-io-sess_subagent_agent_demo-1.jsonl");
const foreignFile = join(dir, "model-io-sess_subagent_agent_foreign-9.jsonl");
const childCursor = join(
  home,
  ".slopwatch",
  "listeners",
  `zcode-${mainSessionId}.sub-sess_subagent_agent_demo-1.cursor`,
);

const spawnLive = async (): Promise<void> => {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "live.ts"),
      "--file",
      mainFile,
      "--session-id",
      mainSessionId,
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

const eventsOf = (sessionId: string, kind?: string): NormalEvent[] =>
  received
    .flat()
    .filter(
      (e) => e.session_id === sessionId && (kind ? e.kind === kind : true),
    );

describe("zcode live.ts subagent capture", () => {
  test("claims the matching-trace subagent file and ships its child session", async () => {
    writeFileSync(mainFile, `${JSON.stringify(mainTurnRecord)}\n`);
    writeFileSync(childFile, `${JSON.stringify(subagentRecord)}\n`);
    writeFileSync(foreignFile, `${JSON.stringify(foreignSubagentRecord)}\n`);
    await spawnLive();

    const childId = "sess_subagent_agent_demo-1";
    const foreignId = "sess_subagent_agent_foreign-9";

    const starts = eventsOf(childId).filter(
      (e) => e.kind === "session" && e.event === "start",
    );
    expect(starts.length).toBeGreaterThan(0);
    expect(
      (starts[0] as { parent_session_id?: string }).parent_session_id,
    ).toBe(mainSessionId);

    const metas = eventsOf(childId).filter(
      (e) => e.kind === "session" && e.event === "meta",
    );
    expect(metas.length).toBe(1);
    expect((metas[0] as { title?: string }).title).toMatch(/^↳ Search/);

    const turnStarts = eventsOf(childId).filter(
      (e) => e.kind === "turn" && e.event === "start",
    );
    expect(turnStarts.length).toBe(1);
    expect((turnStarts[0] as { user_message?: string }).user_message).toContain(
      "rollout capture gaps",
    );

    const requests = eventsOf(childId, "model_request");
    expect(requests.length).toBe(1);
    const usage = (requests[0] as { usage?: { input_tokens?: number } }).usage;
    expect(usage?.input_tokens).toBe(500);

    const ends = eventsOf(childId).filter(
      (e) => e.kind === "session" && e.event === "end",
    );
    expect(ends.length).toBe(1);

    // the foreign-trace file belongs to another main session — never adopted
    expect(eventsOf(foreignId).length).toBe(0);
  }, 30000);

  test("respawn resumes the child cursor — only new records re-ship", async () => {
    received.length = 0;
    appendFileSync(childFile, `${JSON.stringify(secondSubagentRecord)}\n`);
    await spawnLive();

    const childId = "sess_subagent_agent_demo-1";
    const requests = eventsOf(childId, "model_request");
    expect(requests.length).toBe(1);
    const usage = (requests[0] as { usage?: { input_tokens?: number } }).usage;
    expect(usage?.input_tokens).toBe(700);

    // a fresh generation re-asserts the child start (last-write-wins status)
    const starts = eventsOf(childId).filter(
      (e) => e.kind === "session" && e.event === "start",
    );
    expect(starts.length).toBe(1);
  }, 30000);

  test("child cursor file uses the per-child naming", () => {
    expect(existsSync(childCursor)).toBe(true);
  });

  test("cleanup", () => {
    server.stop(true);
  });
});
