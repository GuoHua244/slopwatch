import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeCodeAdapter } from "./adapter";
import {
  aiTitleRecord,
  interleavedToolResultRecord,
  nextMessageRecord,
  promptRecord,
  sidechainAssistantRecord,
  subagentAssistantRecord,
  subagentPromptRecord,
} from "./fixtures/transcript-record";

// The adapter owns what survives a respawn: per-session tail state persisted
// to a sidecar, the primary stream's sidechain guard, and child-session
// lifecycle markers. The respawn scenario below is the real one — PostToolUse
// re-spawns mid-turn after an idle exit, and the cursor resumes mid-transcript
// with the model_request's turn attribution still intact.

const makeAdapter = (primary = "sess_main") => {
  const stateDir = mkdtempSync(join(tmpdir(), "slopwatch-cc-adapter-"));
  return {
    api: createClaudeCodeAdapter({ primarySessionId: primary, stateDir }),
    stateDir,
  };
};

describe("primary stream", () => {
  test("inline sidechain records produce nothing for the parent session", () => {
    const { api } = makeAdapter();
    expect(
      api.adapter.eventsFromRecord(sidechainAssistantRecord, "sess_main"),
    ).toEqual([]);
  });

  test("the same sidechain record normalizes for a child session", () => {
    const { api } = makeAdapter();
    // a child transcript's first record is a user record — its turn:start
    // carries the ↳ title; the assistant reply then normalizes normally
    const events = api.adapter.eventsFromRecord(
      subagentPromptRecord,
      "agent-1",
    );
    expect(events.some((e) => e.kind === "turn" && e.event === "start")).toBe(
      true,
    );
    expect(events.some((e) => e.kind === "session" && e.event === "meta")).toBe(
      true, // the ↳ title arrives with the child's first turn
    );
  });

  test("state persists across adapter generations (the respawn path)", () => {
    const { api, stateDir } = makeAdapter();
    api.adapter.eventsFromRecord(promptRecord, "sess_main");
    api.adapter.eventsFromRecord(sidechainAssistantRecord, "sess_main"); // ignored
    api.adapter.eventsFromRecord(
      {
        ...sidechainAssistantRecord,
        isSidechain: false,
        uuid: "a-1",
        message: {
          id: "msg_01A",
          role: "assistant",
          model: "m",
          content: [
            { type: "tool_use", id: "toolu_01A", name: "Bash", input: {} },
          ],
        },
      },
      "sess_main",
    );
    const sidecar = join(stateDir, "claude-code-sess_main.tailstate.json");
    expect(existsSync(sidecar)).toBe(true);

    // a fresh adapter (the respawned listener) restores from the sidecar
    const reborn = createClaudeCodeAdapter({
      primarySessionId: "sess_main",
      stateDir,
    });
    expect(reborn.primaryTurnId()).toBe("u-0001");
    const events = reborn.adapter.eventsFromRecord(
      interleavedToolResultRecord,
      "sess_main",
    );
    const result = events.find((e) => e.kind === "tool");
    if (result!.kind === "tool") expect(result!.tool).toBe("Bash");
  });
});

describe("child sessions", () => {
  test("a child's first turn ships the ↳ title meta exactly once", () => {
    const { api } = makeAdapter();
    const first = api.adapter.eventsFromRecord(subagentPromptRecord, "agent-1");
    const second = api.adapter.eventsFromRecord(
      subagentAssistantRecord,
      "agent-1",
    );
    const titles = [...first, ...second].filter(
      (e) => e.kind === "session" && e.event === "meta" && "title" in e,
    );
    expect(titles).toHaveLength(1);
    expect((titles[0] as { title: string }).title).toContain("↳");
  });

  test("teardown flushes every session's open message and persists", () => {
    const { api, stateDir } = makeAdapter();
    api.adapter.eventsFromRecord(subagentPromptRecord, "agent-1");
    api.adapter.eventsFromRecord(subagentAssistantRecord, "agent-1");
    api.adapter.eventsFromRecord(promptRecord, "sess_main");
    api.adapter.eventsFromRecord(
      { ...subagentAssistantRecord, isSidechain: false },
      "sess_main",
    );
    const flushed = api.adapter.onTeardown!();
    const requests = flushed.filter((e) => e.kind === "model_request");
    expect(requests).toHaveLength(2); // the child's and the primary's
    // sidecars record the flush so a later generation cannot re-ship them
    expect(
      existsSync(join(stateDir, "claude-code-agent-1.tailstate.json")),
    ).toBe(true);
    const snapshot = JSON.parse(
      readFileSync(
        join(stateDir, "claude-code-agent-1.tailstate.json"),
        "utf8",
      ),
    );
    expect(snapshot.open).toBeNull();
    expect(snapshot.seenMessageIds).toContain("msg_sub01");
  });

  test("forgetSession drops memory and the sidecar", () => {
    const { api, stateDir } = makeAdapter();
    api.adapter.eventsFromRecord(subagentPromptRecord, "agent-1");
    const sidecar = join(stateDir, "claude-code-agent-1.tailstate.json");
    expect(existsSync(sidecar)).toBe(true);
    api.forgetSession("agent-1");
    expect(existsSync(sidecar)).toBe(false);
  });
});

describe("title gating", () => {
  const titleRecord = (text: string): Record<string, unknown> => ({
    ...aiTitleRecord,
    aiTitle: text,
  });
  const summaryRecord = (text: string): Record<string, unknown> => ({
    type: "summary",
    summary: text,
  });
  const titlesFrom = (events: { kind: string }[]): string[] =>
    events
      .filter((e) => e.kind === "session")
      .map((e) => (e as { title?: string }).title)
      .filter((t): t is string => typeof t === "string");

  test("identical ai-title rewrites ship once; a real retitle ships again", () => {
    const { api } = makeAdapter();
    const first = api.adapter.eventsFromRecord(
      titleRecord("first"),
      "sess_main",
    );
    // the periodic unchanged rewrite — suppressed
    const repeat = api.adapter.eventsFromRecord(
      titleRecord("first"),
      "sess_main",
    );
    // a real retitle ships
    const second = api.adapter.eventsFromRecord(
      titleRecord("second"),
      "sess_main",
    );
    expect(titlesFrom(first)).toEqual(["first"]);
    expect(titlesFrom(repeat)).toEqual([]);
    expect(titlesFrom(second)).toEqual(["second"]);
  });

  test("the legacy summary record gates the same way as ai-title", () => {
    const { api } = makeAdapter();
    expect(
      titlesFrom(
        api.adapter.eventsFromRecord(summaryRecord("legacy"), "sess_main"),
      ),
    ).toEqual(["legacy"]);
    // a resume re-appends the same summary — suppressed
    expect(
      titlesFrom(
        api.adapter.eventsFromRecord(summaryRecord("legacy"), "sess_main"),
      ),
    ).toEqual([]);
    expect(
      titlesFrom(
        api.adapter.eventsFromRecord(summaryRecord("redone"), "sess_main"),
      ),
    ).toEqual(["redone"]);
  });

  test("a respawned adapter does not re-ship the persisted title", () => {
    const { api, stateDir } = makeAdapter();
    api.adapter.eventsFromRecord(titleRecord("kept"), "sess_main");
    // persist swallows write errors — pin the sidecar before the respawn so a
    // persistence failure cannot masquerade as a suppression-gate success
    expect(
      existsSync(join(stateDir, "claude-code-sess_main.tailstate.json")),
    ).toBe(true);
    const reborn = createClaudeCodeAdapter({
      primarySessionId: "sess_main",
      stateDir,
    });
    // a cursor replay resurfaces an already-shipped title record — suppressed
    const events = reborn.adapter.eventsFromRecord(
      titleRecord("kept"),
      "sess_main",
    );
    expect(events.find((e) => e.kind === "session")).toBeUndefined();
  });
});

describe("request grouping through the adapter", () => {
  test("the primary's open message closes on the next message id", () => {
    const { api } = makeAdapter();
    api.adapter.eventsFromRecord(promptRecord, "sess_main");
    api.adapter.eventsFromRecord(
      {
        ...sidechainAssistantRecord,
        isSidechain: false,
        uuid: "a-1",
        message: {
          id: "msg_01A",
          role: "assistant",
          model: "m",
          content: [{ type: "text", text: "hello" }],
        },
      },
      "sess_main",
    );
    const events = api.adapter.eventsFromRecord(nextMessageRecord, "sess_main");
    expect(events.filter((e) => e.kind === "model_request")).toHaveLength(1);
  });
});
