import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { HOOK_EVENTS } from "./install";
import { HEARTBEAT_TTL_MS } from "@slopwatch/listener-shared";

// Regression pins for the v1 decision 19 post-mortem, Claude Code side: the
// hooks never miss a user message — capture died after the listener's idle
// exit, because nothing re-spawned it mid-turn and Windows PID reuse defeated
// signal-0 checks. ZCode pins the same wiring in its own decision19 test.

describe("decision 19 capture-recovery wiring", () => {
  test("PostToolUse is a wired hook event — mid-turn re-spawn exists", () => {
    expect([...HOOK_EVENTS]).toContain("PostToolUse");
    expect([...HOOK_EVENTS]).toContain("SessionStart");
    expect([...HOOK_EVENTS]).toContain("UserPromptSubmit");
    expect([...HOOK_EVENTS]).toContain("SessionEnd");
  });

  test("the idle window is 5 minutes, not the original 2", () => {
    expect(HEARTBEAT_TTL_MS).toBe(5 * 60_000);
  });
});

describe("hook entry refuses to run without a payload", () => {
  test("a --stop without --session-id exits non-zero", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "hook.ts"), "--stop"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(code).toBe(1);
  }, 20_000); // bun cold start ~3s on this machine; CI parallelism adds more
});
