import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalEvent } from "@slopwatch/events";

// v2 decision 21 on the claude-code hook: the hook is the ONLY sender of
// session:end, so a failed POST must queue the event to disk — the sweep
// spawned by the next hook fire ships it.

const dir = mkdtempSync(join(tmpdir(), "slopwatch-hook-queue-"));
const home = join(dir, "home");
const sessionId = "sess_hook-queue";
const queueFile = join(
  home,
  ".slopwatch",
  "listeners",
  `claude-code-${sessionId}.queue.jsonl`,
);

describe("claude-code hook queues an undeliverable session:end", () => {
  test("dead server → end event lands in the session's queue file", async () => {
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        join(import.meta.dir, "hook.ts"),
        "--server-url",
        "http://127.0.0.1:1",
        "--token",
        "t",
      ],
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(
      JSON.stringify({ hook_event_name: "SessionEnd", session_id: sessionId }),
    );
    proc.stdin.end();
    const [code] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(code).toBe(0);

    expect(existsSync(queueFile)).toBe(true);
    const lines = readFileSync(queueFile, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { events: NormalEvent[] });
    const ends = lines
      .flatMap((l) => l.events)
      .filter(
        (e) =>
          e.kind === "session" && (e as { event?: string }).event === "end",
      );
    expect(ends.length).toBe(1);
    expect(ends[0]!.session_id).toBe(sessionId);
    // the hook spawns bun (seconds on Windows) and its POST waits out a 3s
    // timeout — 15s flaked whenever the full monorepo suite ran in parallel
  }, 60_000);
});
