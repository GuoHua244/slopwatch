import { describe, expect, test } from "bun:test";
import type {
  SessionStartEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "@slopwatch/events";
import {
  commitCommandFromArgs,
  commitOutputFromRaw,
  commitSubjectFromCommand,
  isCommitCall,
  stringsFromArgs,
} from "./commits";

describe("commit extraction (v3 decision 34)", () => {
  test("stringsFromArgs collects embedded command strings, capped", () => {
    expect(
      stringsFromArgs({ command: "git commit -m x", description: "commit" }),
    ).toEqual(["git commit -m x", "commit"]);
    expect(
      stringsFromArgs({ nested: { deep: { cmd: ["a", 1, true] } } }),
    ).toEqual(["a"]);
    expect(stringsFromArgs(null)).toEqual([]);
    // Pathological args cap out instead of scanning forever.
    const big = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`k${i}`, "x"]),
    );
    expect(stringsFromArgs(big)).toHaveLength(20);
  });

  test("isCommitCall matches git commit shapes, rejects dry runs and lookalikes", () => {
    expect(isCommitCall("git commit -m 'x'")).toBe(true);
    expect(isCommitCall("git -C sub commit -m 'x'")).toBe(true);
    expect(isCommitCall("cd app && git commit -m 'x'")).toBe(true);
    expect(isCommitCall("docker commit c1 img")).toBe(false);
    expect(isCommitCall("git rebase --onto commit")).toBe(false);
    expect(isCommitCall("git status")).toBe(false);
    expect(isCommitCall("git commit --dry-run")).toBe(false);
  });

  test("commitSubjectFromCommand lifts -m subjects, quoted or bare", () => {
    expect(commitSubjectFromCommand('git commit -m "fix the login bug"')).toBe(
      "fix the login bug",
    );
    expect(commitSubjectFromCommand("git commit -m 'add tests'")).toBe(
      "add tests",
    );
    expect(commitSubjectFromCommand("git commit --message='a b'")).toBe("a b");
    expect(commitSubjectFromCommand("git commit -m quickfix")).toBe("quickfix");
    expect(commitSubjectFromCommand("git commit")).toBeNull();
  });

  test("commitOutputFromRaw mines git's own output from a raw record", () => {
    expect(
      commitOutputFromRaw({ content: "[main abc1234] fix the bug" }),
    ).toEqual({ branch: "main", sha: "abc1234", subject: "fix the bug" });
    // The (root-commit) annotation and the trailing stat lines stay out of
    // the subject.
    expect(
      commitOutputFromRaw({
        content: "[main (root-commit) def5678] initial\n 2 files changed",
      }),
    ).toEqual({ branch: "main", sha: "def5678", subject: "initial" });
    // Multi-line subjects survive the JSON newline escapes.
    expect(
      commitOutputFromRaw({ content: "[dev 1112223] headline\\nbody line" }),
    ).toEqual({ branch: "dev", sha: "1112223", subject: "headline" });
    expect(commitOutputFromRaw({ content: "nothing here" })).toBeNull();
    expect(commitOutputFromRaw(undefined)).toBeNull();
  });
});

// --- Postgres-backed: ingest records the call, the result enriches it ---

const dbTests = () =>
  (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL) !== undefined;
const testDsn = () =>
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!;

const toolCall = (
  sessionId: string,
  toolCallId: string,
  args: unknown,
  occurredAt = "2026-09-11T17:01:00Z",
): ToolCallEvent => ({
  schema_version: 1,
  agent: "claude-code",
  session_id: sessionId,
  occurred_at: occurredAt,
  kind: "tool",
  event: "call",
  tool_call_id: toolCallId,
  tool: "Bash",
  args,
});

const toolResult = (
  sessionId: string,
  toolCallId: string,
  raw: unknown,
  occurredAt = "2026-09-11T17:01:05Z",
): ToolResultEvent => ({
  schema_version: 1,
  agent: "claude-code",
  session_id: sessionId,
  occurred_at: occurredAt,
  kind: "tool",
  event: "result",
  tool_call_id: toolCallId,
  tool: "Bash",
  ok: true,
  raw,
});

const sessionStart = (sessionId: string): SessionStartEvent => ({
  schema_version: 1,
  agent: "claude-code",
  session_id: sessionId,
  occurred_at: "2026-09-11T17:00:00Z",
  kind: "session",
  event: "start",
  cwd: "D:\\demo",
  hostname: "DEV-01",
});

describe.skipIf(!dbTests())("session commits against Postgres", () => {
  let store: import("./store").Store | undefined;
  const ensure = async () => {
    if (store) return;
    const { createPgStore } = await import("./store");
    store = createPgStore(testDsn());
    await store.migrate();
  };

  test("a git commit call records a row; the result's raw fills the sha", async () => {
    await ensure();
    const user = `commits-${crypto.randomUUID().slice(0, 8)}`;
    const sid = `sess_commits-${crypto.randomUUID().slice(0, 8)}`;
    await store!.appendEvents(
      [
        sessionStart(sid),
        toolCall(sid, "c1", { command: 'git commit -m "fix the login bug"' }),
        // Non-commit and dry-run calls record nothing.
        toolCall(sid, "c2", { command: "bun test" }),
        toolCall(sid, "c3", { command: "git commit --dry-run" }),
      ],
      user,
    );
    expect(await store!.listSessionCommits(sid)).toEqual([
      {
        session_id: sid,
        tool_call_id: "c1",
        subject: "fix the login bug",
        branch: null,
        sha: null,
        occurred_at: "2026-09-11T17:01:00.000Z",
      },
    ]);

    // The result lands in a later batch, with git's own output in raw.
    await store!.appendEvents(
      [
        toolResult(sid, "c1", {
          content: "[main abc1234] fix the login bug\n 2 files changed",
        }),
        // An unrelated result enriches nothing.
        toolResult(sid, "c2", { content: "42 tests pass" }),
      ],
      user,
    );
    expect(await store!.listSessionCommits(sid)).toEqual([
      {
        session_id: sid,
        tool_call_id: "c1",
        subject: "fix the login bug",
        branch: "main",
        sha: "abc1234",
        occurred_at: "2026-09-11T17:01:00.000Z",
      },
    ]);

    // Deleting the session takes its commits with it.
    expect(await store!.deleteSession(sid)).toBe(true);
    expect(await store!.listSessionCommits(sid)).toEqual([]);
  });

  test("cleanup", async () => {
    if (store) await store.close();
  });
});
