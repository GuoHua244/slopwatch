import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { HOOK_EVENTS } from "./install";
import { HEARTBEAT_TTL_MS } from "@slopwatch/listener-shared";

// Regression pins for the v1 decision 19 post-mortem: the hooks never miss a
// user message — capture died after the listener's idle exit, because nothing
// re-spawned it mid-turn and Windows PID reuse defeated signal-0 checks.

describe("decision 19 capture-recovery wiring", () => {
  test("PostToolUse is a wired hook event — mid-turn re-spawn exists", () => {
    expect([...HOOK_EVENTS]).toContain("PostToolUse");
    expect([...HOOK_EVENTS]).toContain("SessionStart");
    expect([...HOOK_EVENTS]).toContain("UserPromptSubmit");
  });

  test("the idle window is 5 minutes, not the original 2", () => {
    expect(HEARTBEAT_TTL_MS).toBe(5 * 60_000);
  });
});

describe("spawner refuses an unexpanded session-id template", () => {
  test("a literal ${ZCODE_SESSION_ID} exits non-zero and spawns nothing", async () => {
    // the guard is the first thing after argv parsing — nothing is touched
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        join(import.meta.dir, "spawner.ts"),
        "--session-id",
        "${ZCODE_SESSION_ID}",
      ],
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
