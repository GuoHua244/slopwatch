import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalEvent } from "@slopwatch/events";
import {
  promptRecord,
  assistantTextRecord,
} from "./fixtures/transcript-record";

// v2 decision 21 end-to-end on the real claude-code listener: with the server
// down, a flush must QUEUE the batch to disk and still advance the cursor
// (the transcript can be compacted away — the queue is what preserves the
// data now), and a later sweep must ship the queued batches to a recovered
// server.

const dir = mkdtempSync(join(tmpdir(), "slopwatch-claude-queue-"));
const home = join(dir, "home");
const transcript = join(dir, "transcript.jsonl");
const stateDir = join(home, ".slopwatch", "listeners");
const queueFile = join(stateDir, "claude-code-sess_queue-e2e.queue.jsonl");
const cursorFile = join(stateDir, "claude-code-sess_queue-e2e.cursor");

const runScript = async (
  script: string,
  args: string[],
  serverUrl: string | null,
): Promise<number> => {
  const cmd = [process.execPath, join(import.meta.dir, script), ...args];
  if (serverUrl) cmd.push("--server-url", serverUrl, "--token", "t");
  const proc = Bun.spawn({
    cmd,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  return code;
};

describe("claude-code disk-buffer end-to-end (decision 21)", () => {
  test("server down: batch queued, cursor advanced, sweep replays on recovery", async () => {
    // nothing listens on port 1 → every POST fails
    writeFileSync(
      transcript,
      [
        JSON.stringify(promptRecord),
        JSON.stringify(assistantTextRecord),
        JSON.stringify(nextMessageRecordOf()),
      ].join("\n") + "\n",
    );
    const exitCode = await runScript(
      "live.ts",
      [
        "--file",
        transcript,
        "--session-id",
        "sess_queue-e2e",
        "--cwd",
        dir,
        "--idle-ms",
        "200",
        "--max-lifetime-ms",
        "1500",
      ],
      "http://127.0.0.1:1",
    );
    expect(exitCode).toBe(0);

    // the queue holds the events; the cursor no longer waits on the transcript
    expect(existsSync(queueFile)).toBe(true);
    const queued = readFileSync(queueFile, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { events: NormalEvent[] });
    const kinds = queued.flatMap((e) => e.events.map((v) => v.kind));
    expect(kinds).toContain("session"); // start + end
    expect(kinds).toContain("model_request");
    expect(Number(readFileSync(cursorFile, "utf8"))).toBeGreaterThan(0);

    // recovery: a server comes up; the sweep ships the queued batches
    const received: NormalEvent[][] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/healthz") return new Response("ok");
        // the fold gate probes credential status on every end — these fixtures
        // exercise the unconfigured path
        if (path === "/summary/llm")
          return Response.json({ configured: false });
        received.push(((await req.json()) as { events: NormalEvent[] }).events);
        return Response.json({ accepted: 1 });
      },
    });
    try {
      const drainExit = await runScript(
        "drain.ts",
        [],
        `http://127.0.0.1:${server.port}`,
      );
      expect(drainExit).toBe(0);
      const kinds = received
        .flat()
        .map(
          (e) =>
            e.kind +
            ("event" in e && typeof e.event === "string" ? `:${e.event}` : ""),
        );
      expect(kinds).toContain("session:start");
      expect(kinds).toContain("model_request");
      expect(kinds).toContain("session:end");
    } finally {
      server.stop(true);
    }
  }, 30_000);
});

const nextMessageRecordOf = (): Record<string, unknown> => ({
  ...assistantTextRecord,
  uuid: "a-close",
  message: {
    ...assistantTextRecord.message,
    id: "msg_close",
    content: [{ type: "text", text: "close" }],
  },
});
