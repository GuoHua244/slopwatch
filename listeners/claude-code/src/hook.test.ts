import { describe, expect, test } from "bun:test";
import { planHook } from "./hook";

const base = {
  session_id: "3f1d9c2e-1111-4bbb-9c2e-000000000001",
  transcript_path: "C:\\Users\\dev\\.claude\\projects\\h\\3f1d.jsonl",
  cwd: "D:\\repo",
  hook_event_name: "SessionStart",
};

describe("planHook", () => {
  test("SessionStart spawns a sidecar bound to the transcript", () => {
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

  test("other hook events are ignored", () => {
    expect(planHook({ ...base, hook_event_name: "PostToolUse" }).kind).toBe(
      "none",
    );
  });

  test("malformed input is ignored, never thrown on", () => {
    expect(planHook(null).kind).toBe("none");
    expect(planHook("nope").kind).toBe("none");
    expect(planHook({ hook_event_name: "SessionStart" }).kind).toBe("none");
  });
});
