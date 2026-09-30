/**
 * Live-tail a Claude Code transcript and emit normalized events — NDJSON on
 * stdout, or POST batches to a Slopwatch server when --server-url/--token are
 * given. Backfills the existing file first, then watches for appends. Claude
 * Code HAS a SessionEnd hook (the hook script ships session:end and requests
 * a graceful stop), so idle timeout is only the fallback for lost end events.
 *
 * Subagent sessions are captured from their own transcripts: each Task tool
 * run writes `<transcript-dir>/<session-id>/subagents/agent-<id>.jsonl` (the
 * directory name scopes the files to this session — no claim check needed).
 * They are discovered on the poll cadence, tailed with their own cursor, and
 * bracketed by child session:start (with parent_session_id/spawned_by_turn_id)
 * and session:end markers so the server's child-session rollups (ADR 0008)
 * see them.
 *
 * The tail/watch/teardown skeleton lives in listener-shared's
 * createLiveListener; this file is only the Claude Code adapter.
 *
 * Usage: bun live.ts --file <transcript> --session-id <id> [--cwd <dir>]
 *        [--git-remote URL] [--idle-ms 300000] [--max-lifetime-ms 14400000]
 *        [--server-url http://host:port --token <bearer>]
 */
import { readFileSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isNonEmptyString,
  type NormalEvent,
  type SessionEndEvent,
  type SessionStartEvent,
} from "@slopwatch/events";
import { resolveShipConfig } from "@slopwatch/config";
import {
  argvHelpers,
  createLiveListener,
  type ChildTail,
} from "@slopwatch/listener-shared";
import { childSessionMarkers, createClaudeCodeAdapter } from "./adapter";

const { arg, numArg } = argvHelpers(process.argv.slice(2));

const file = arg("file");
const sessionId = arg("session-id") ?? "unknown-session";
// argv pair wins for manual runs; otherwise the central config written by
// `slopwatch install` (the installed hook carries no credentials at all)
const ship = resolveShipConfig({
  serverUrl: arg("server-url"),
  token: arg("token"),
});

if (!file) {
  console.error(
    "usage: bun live.ts --file <transcript> --session-id <id> [--server-url U --token T]  (server-url/token default to ~/.slopwatch/config.json)",
  );
  process.exit(1);
}

// --- Subagent capture --------------------------------------------------------

const SUBAGENTS_DIR = join(dirname(file), sessionId, "subagents");
const AGENT_FILE = /^agent-(.+)\.jsonl$/;
const cwd = arg("cwd") ?? process.cwd();
const gitRemote = arg("git-remote");

let spawnedByTurnId: string | undefined;
const claimedFiles = new Set<string>();

/**
 * The child transcript's own start time: its first record carries the spawn
 * moment — more faithful than the discovery instant for a file claimed
 * after the subagent already ran (a respawned listener catching up).
 */
const firstRecordTimestamp = (path: string): string | null => {
  try {
    const line = readFileSync(path, "utf8")
      .split("\n")
      .find((l) => l.trim());
    if (!line) return null;
    const record = JSON.parse(line) as { timestamp?: unknown };
    return isNonEmptyString(record.timestamp) ? record.timestamp : null;
  } catch {
    return null;
  }
};

const adapterApi = createClaudeCodeAdapter({ primarySessionId: sessionId });
const adapter = adapterApi.adapter;

const childTails = {
  discover: (): ChildTail[] => {
    // the primary tail loads the persisted turn state on its first drained
    // record; discovery riding the same chain keeps spawned_by_turn_id honest
    spawnedByTurnId = adapterApi.primaryTurnId() ?? spawnedByTurnId;
    let names: string[];
    try {
      names = readdirSync(SUBAGENTS_DIR);
    } catch {
      return []; // no subagents (yet) — the directory appears with the first Task
    }
    const tails: ChildTail[] = [];
    for (const name of names) {
      const match = name.match(AGENT_FILE);
      if (!match) continue;
      const childFile = join(SUBAGENTS_DIR, name);
      if (claimedFiles.has(childFile)) continue;
      claimedFiles.add(childFile);
      const childId = match[1]!;
      const markers = childSessionMarkers({
        childId,
        parentId: sessionId,
        spawnedByTurnId,
        cwd,
        hostname: hostname(),
        gitRemote,
        startedAt: firstRecordTimestamp(childFile) ?? new Date().toISOString(),
      });
      tails.push({
        file: childFile,
        sessionId: childId,
        onStart: (): SessionStartEvent[] => [markers.start],
        onEnd: (reason: string): SessionEndEvent[] => {
          // the child's tail state (turn attribution, dedup sets, the title
          // gate) must survive this end: an idle exit is not a final one, and
          // the resumed generation restores from the same sidecar — dropping
          // it here left every later model_request unattributed (no turn_id),
          // which the review view files as orphans
          return [markers.end(reason)];
        },
        // child turns must not close the parent turn being digested — only
        // their requests/tools fold into it
        digestTransform: (events: NormalEvent[]) =>
          events.filter((e) => !(e.kind === "turn" && e.event === "start")),
      });
    }
    return tails;
  },
};

await createLiveListener({
  agent: "claude-code",
  file,
  sessionId,
  cwd,
  // the hook resolves the git remote from its own cwd and passes it along
  gitRemote,
  // 5 minutes (as ZCode's decision-19 fix): a long tool call must not idle-end
  // the listener mid-turn — PostToolUse re-spawns cover the genuinely dead case.
  idleMs: numArg("idle-ms", 300_000),
  maxLifetimeMs: numArg("max-lifetime-ms", 4 * 60 * 60 * 1000),
  serverUrl: ship?.serverUrl,
  token: ship?.token,
  adapter,
  childTails,
  heartbeat: true,
  // the fold is cheap to attempt: no healthz gate, a lost POST costs nothing
  // the queue has not already preserved
  probeBeforeFold: false,
  drainScript: fileURLToPath(new URL("./drain.ts", import.meta.url)),
});
