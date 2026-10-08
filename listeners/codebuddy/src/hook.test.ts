/**
 * Hook dispatch tests. CodeBuddy hands us one JSON payload per event on
 * stdin, and which events it actually fires decides the whole lifecycle —
 * these pin that `PostToolUse` spawns (it is the only event that fires
 * reliably enough to be the re-spawn heartbeat) and that nothing else does.
 */
import { describe, expect, test } from "bun:test";
import { planHook } from "./hook";
import { realHookPayload } from "./fixtures/history-record";

const SESSION = "775cc5f8f8604b798be88bbf9bc3c06d";
const TRANSCRIPT = "C:\\history\\index.json";

describe("planHook", () => {
  test("the real PostToolUse payload asks for a spawn", () => {
    const plan = planHook(realHookPayload);
    expect(plan).toEqual({
      kind: "spawn",
      sessionId: SESSION,
      transcriptPath: realHookPayload.transcript_path,
      // advisory: this host reports the IDE install dir, live.ts replaces it
      cwd: "D:\\software\\CodeBuddy CN",
    });
  });

  test("SessionStart, UserPromptSubmit and PostToolUse all spawn", () => {
    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse"]) {
      expect(
        planHook({
          hook_event_name: event,
          session_id: SESSION,
          transcript_path: TRANSCRIPT,
        }),
      ).toMatchObject({ kind: "spawn" });
    }
  });

  test("SessionEnd ends the session, with its reason when it has one", () => {
    expect(
      planHook({
        hook_event_name: "SessionEnd",
        session_id: SESSION,
        reason: "clear",
      }),
    ).toEqual({ kind: "end", sessionId: SESSION, reason: "clear" });
    expect(
      planHook({ hook_event_name: "SessionEnd", session_id: SESSION }),
    ).toEqual({ kind: "end", sessionId: SESSION, reason: undefined });
  });

  test("events we do not handle are ignored, loudly enough to debug", () => {
    const plan = planHook({
      hook_event_name: "Notification",
      session_id: SESSION,
    });
    expect(plan.kind).toBe("none");
    if (plan.kind === "none")
      expect(plan.reason).toContain("unhandled event Notification");
  });

  test("a payload without session_id or transcript_path is refused", () => {
    expect(planHook({ hook_event_name: "PostToolUse" })).toMatchObject({
      kind: "none",
    });
    expect(
      planHook({ hook_event_name: "PostToolUse", session_id: SESSION }),
    ).toMatchObject({ kind: "none" });
    expect(planHook(null)).toMatchObject({ kind: "none" });
    expect(planHook("a string")).toMatchObject({ kind: "none" });
  });

  test("a spawn without a usable cwd still spawns — live.ts re-derives it", () => {
    const plan = planHook({
      hook_event_name: "PostToolUse",
      session_id: SESSION,
      transcript_path: TRANSCRIPT,
    });
    expect(plan).toEqual({
      kind: "spawn",
      sessionId: SESSION,
      transcriptPath: TRANSCRIPT,
    });
  });
});
