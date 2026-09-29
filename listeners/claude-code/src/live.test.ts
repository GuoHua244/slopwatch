import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalEvent } from "@slopwatch/events";
import {
  assistantThinkingRecord,
  promptRecord,
} from "./fixtures/transcript-record";

// Runs the real live.ts twice against the same session id. The second spawn
// resumes from a non-zero cursor — the re-attach path that must re-assert
// session:start, or the dashboard's last-end-wins status strands the session
// on "ended · idle-timeout" forever.

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

const dir = mkdtempSync(join(tmpdir(), "slopwatch-claude-live-"));
const home = join(dir, "home");
const transcript = join(dir, "transcript.jsonl");

const spawnLive = async (): Promise<void> => {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "live.ts"),
      "--file",
      transcript,
      "--session-id",
      "sess_live-start-test",
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
    // isolate the cursor file so the second spawn takes the re-attach path
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

const startCount = (): number =>
  received.flat().filter((e) => e.kind === "session" && e.event === "start")
    .length;

describe("claude-code live.ts session:start across re-attach", () => {
  test("first spawn sends session:start", async () => {
    writeFileSync(transcript, `${JSON.stringify(promptRecord)}\n`);
    await spawnLive();
    expect(received.length).toBeGreaterThan(0);
    expect(startCount()).toBe(1);
  }, 30000);

  test("re-attach after idle-timeout sends a fresh start", async () => {
    received.length = 0;
    appendFileSync(transcript, `${JSON.stringify(assistantThinkingRecord)}\n`);
    await spawnLive();
    expect(received.length).toBeGreaterThan(0);
    expect(startCount()).toBe(1);
  }, 30000);

  test("cleanup", () => {
    server.stop(true);
  });
});
