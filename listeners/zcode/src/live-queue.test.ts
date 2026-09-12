import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalEvent } from "@slopwatch/events";

// v2 decision 21 end-to-end on the real zcode sidecar: with the server down,
// a flush must QUEUE the batch to disk and still advance the cursor (the
// rollout file can vanish — the queue is what preserves the data now), and a
// later sweep must ship the queued batches to a recovered server.

const dir = mkdtempSync(join(tmpdir(), "slopwatch-zcode-queue-"));
const home = join(dir, "home");
const rollout = join(dir, "rollout.jsonl");
const stateDir = join(home, ".slopwatch", "listeners");
const queueFile = join(stateDir, "zcode-sess_queue-e2e.queue.jsonl");
const cursorFile = join(stateDir, "zcode-sess_queue-e2e.cursor");

const record = {
  type: "model_io",
  sessionId: "sess_queue-e2e",
  turnId: "turn_q-1",
  querySource: "main_turn",
  startedAt: "2026-09-13T10:00:00.000Z",
  completedAt: "2026-09-13T10:00:04.000Z",
  durationMs: 4000,
  requestId: "req_q-1",
  model: {
    modelId: "GLM-5.3-Flash",
    providerId: "builtin:bigmodel-coding-plan",
  },
  request: { messages: [{ role: "user", content: "queue e2e" }] },
  response: { usage: { inputTokens: 10, outputTokens: 5 } },
};

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

describe("zcode disk-buffer end-to-end (decision 21)", () => {
  test("server down: batch queued, cursor advanced, sweep replays on recovery", async () => {
    // nothing listens on port 1 → every POST fails
    writeFileSync(rollout, `${JSON.stringify(record)}\n`);
    const exitCode = await runScript(
      "live.ts",
      [
        "--file",
        rollout,
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

    // the queue holds the events; the cursor no longer waits on the rollout
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
      expect(readFileSync(queueFile, "utf8")).toBe("");
    } finally {
      server.stop(true);
    }
  }, 30_000);
});
