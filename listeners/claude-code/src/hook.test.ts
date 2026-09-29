import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "@slopwatch/config";
import { planHook } from "./hook";

const base = {
  session_id: "3f1d9c2e-1111-4bbb-9c2e-000000000001",
  transcript_path: "C:\\Users\\dev\\.claude\\projects\\h\\3f1d.jsonl",
  cwd: "D:\\repo",
  hook_event_name: "SessionStart",
};

describe("planHook", () => {
  test("SessionStart spawns a listener bound to the transcript", () => {
    const plan = planHook(base);
    expect(plan).toEqual({
      kind: "spawn",
      sessionId: base.session_id,
      transcriptPath: base.transcript_path,
      cwd: "D:\\repo",
    });
  });

  test("UserPromptSubmit re-spawns (liveness check makes it cheap)", () => {
    const plan = planHook({ ...base, hook_event_name: "UserPromptSubmit" });
    expect(plan.kind).toBe("spawn");
  });

  test("SessionEnd ends the session with its reason", () => {
    const plan = planHook({
      ...base,
      hook_event_name: "SessionEnd",
      reason: "clear",
    });
    expect(plan).toEqual({
      kind: "end",
      sessionId: base.session_id,
      reason: "clear",
    });
  });

  test("missing transcript path cannot spawn", () => {
    const { transcript_path: _drop, ...withoutTranscript } = base;
    const plan = planHook(withoutTranscript);
    expect(plan.kind).toBe("none");
  });

  test("PostToolUse re-spawns mid-turn (idle-exit recovery)", () => {
    const plan = planHook({ ...base, hook_event_name: "PostToolUse" });
    expect(plan.kind).toBe("spawn");
  });

  test("other hook events are ignored", () => {
    expect(planHook({ ...base, hook_event_name: "PreToolUse" }).kind).toBe(
      "none",
    );
    expect(planHook({ ...base, hook_event_name: "Stop" }).kind).toBe("none");
  });

  test("malformed input is ignored, never thrown on", () => {
    expect(planHook(null).kind).toBe("none");
    expect(planHook("nope").kind).toBe("none");
    expect(planHook({ hook_event_name: "SessionStart" }).kind).toBe("none");
  });
});

describe("hook entry — capture kill switch (`slopwatch pause`)", () => {
  test("a paused install spawns nothing (hooks stay wired but idle)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slopwatch-cc-pause-"));
    const home = join(dir, "home");
    saveConfig(
      {
        serverUrl: "http://127.0.0.1:1",
        token: "unused",
        disabled: true,
      },
      home,
    );
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        join(import.meta.dir, "hook.ts"),
        "--server-url",
        "http://127.0.0.1:1",
        "--token",
        "unused",
      ],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        SLOPWATCH_HOME: home,
      },
    });
    try {
      proc.stdin.write(
        JSON.stringify({ ...base, hook_event_name: "SessionStart" }),
      );
      proc.stdin.end();
    } catch {
      // the hook exits without reading stdin when paused — a late EPIPE here
      // is the pause working, not a test failure
    }
    const [code, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(stderr).toContain("paused");
    // no listener state appeared for this session
    expect(
      existsSync(
        join(
          home,
          ".slopwatch",
          "listeners",
          `claude-code-${base.session_id}.pid`,
        ),
      ),
    ).toBe(false);
  }, 20_000);
});
