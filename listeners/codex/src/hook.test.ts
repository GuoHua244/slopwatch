import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planHook } from "./hook";
import {
  sessionEndHookPayload,
  sessionStartHookPayload,
  stopHookPayload,
  SESSION_ID,
} from "./fixtures/rollout-record";

describe("codex planHook", () => {
  test("SessionStart spawns with the rollout path and cwd", () => {
    const plan = planHook(sessionStartHookPayload);
    expect(plan).toEqual({
      kind: "spawn",
      sessionId: sessionStartHookPayload.session_id,
      transcriptPath: sessionStartHookPayload.transcript_path,
      cwd: sessionStartHookPayload.cwd,
    });
  });

  test("UserPromptSubmit, PostToolUse, and Stop all spawn", () => {
    for (const event of ["UserPromptSubmit", "PostToolUse", "Stop"]) {
      const plan = planHook({ ...stopHookPayload, hook_event_name: event });
      expect(plan.kind).toBe("spawn");
    }
  });

  test("SessionEnd ends with the payload reason", () => {
    const plan = planHook(sessionEndHookPayload);
    expect(plan).toEqual({
      kind: "end",
      sessionId: sessionEndHookPayload.session_id,
      reason: "other",
    });
  });

  test("a payload without transcript_path spawns nothing (non-local store)", () => {
    const plan = planHook({
      ...sessionStartHookPayload,
      transcript_path: null,
    });
    expect(plan.kind).toBe("none");
  });

  test("unhandled and malformed payloads are ignored", () => {
    expect(
      planHook({ ...stopHookPayload, hook_event_name: "PreToolUse" }).kind,
    ).toBe("none");
    expect(planHook({ hook_event_name: "SessionStart" }).kind).toBe("none");
    expect(planHook(null).kind).toBe("none");
    expect(planHook("not an object").kind).toBe("none");
  });

  test(
    "the entry script ships the end event on stderr (stdout is injected " +
      "into the conversation as context) and exits 0",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "slopwatch-codex-hook-"));
      const proc = Bun.spawn({
        cmd: [process.execPath, join(import.meta.dir, "hook.ts")],
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      proc.stdin.write(JSON.stringify(sessionEndHookPayload));
      await proc.stdin.end();
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(code).toBe(0);
      expect(stdout).toBe(""); // codex speaks anything on stdout aloud
      const end = JSON.parse(stderr.trim());
      expect(end.kind).toBe("session");
      expect(end.event).toBe("end");
      expect(end.agent).toBe("codex");
      expect(end.session_id).toBe(SESSION_ID);
      expect(end.reason).toBe("other");
    },
    30000,
  );
});
