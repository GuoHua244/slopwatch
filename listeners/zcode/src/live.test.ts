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
import { mainTurnRecord } from "./fixtures/rollout-record";

// Runs the real live.ts twice against the same session id. The second spawn
// resumes from a non-zero cursor — the re-attach path that must re-assert
// session:start, or the dashboard's last-end-wins status strands the session
// on "ended · idle-timeout" forever.

const received: NormalEvent[][] = [];
const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const body = (await req.json()) as { events: NormalEvent[] };
    received.push(body.events);
    return Response.json({ accepted: body.events.length });
  },
});

const dir = mkdtempSync(join(tmpdir(), "slopwatch-zcode-live-"));
const home = join(dir, "home");
const rollout = join(dir, "rollout.jsonl");
const heartbeat = join(
  home,
  ".slopwatch",
  "listeners",
  "zcode-sess_live-start-test.heartbeat",
);

const spawnLive = async (): Promise<void> => {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "live.ts"),
      "--file",
      rollout,
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

describe("zcode live.ts session:start across re-attach", () => {
  test("first spawn sends session:start", async () => {
    writeFileSync(rollout, `${JSON.stringify(mainTurnRecord)}\n`);
    await spawnLive();
    expect(received.length).toBeGreaterThan(0);
    expect(startCount()).toBe(1);
    // the spawner's respawn decision reads this file — it must exist by exit
    expect(existsSync(heartbeat)).toBe(true);
  }, 30000);

  test("re-attach after idle-timeout sends a fresh start", async () => {
    received.length = 0;
    appendFileSync(rollout, `${JSON.stringify(mainTurnRecord)}\n`);
    await spawnLive();
    expect(received.length).toBeGreaterThan(0);
    expect(startCount()).toBe(1);
  }, 30000);

  test("cleanup", () => {
    server.stop(true);
  });
});
