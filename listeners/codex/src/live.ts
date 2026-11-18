/**
 * Live-tail a Codex rollout file and emit normalized events — NDJSON on
 * stdout, or POST batches to a Slopwatch server when --server-url/--token
 * are given. Backfills the existing file first, then watches for appends.
 * Codex HAS a SessionEnd hook (the hook script ships session:end and
 * requests a graceful stop after the rollout is flushed), so idle timeout is
 * only the fallback for lost end events.
 *
 * Subagent sessions are captured from their own rollout files: Codex writes
 * each subagent thread to `rollout-…-<child-uuid>.jsonl` in the same date
 * directory, sharing the parent's root `session_id` in its session_meta.
 * They are discovered on the poll cadence (first record read: thread_source
 * "subagent" + direct-parent check), tailed with their own cursor, and
 * bracketed by child session:start (with parent_session_id /
 * spawned_by_turn_id) and session:end markers so the server's child-session
 * rollups (ADR 0008) see them.
 *
 * The tail/watch/teardown skeleton lives in listener-shared's
 * createLiveListener; this file is only the Codex adapter wiring.
 *
 * Usage: bun live.ts --file <rollout> --session-id <thread-uuid> [--cwd <dir>]
 *        [--git-remote URL] [--idle-ms 300000] [--max-lifetime-ms 14400000]
 *        [--server-url http://host:port --token <bearer>]
 */
import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isNonEmptyString,
  isObject,
  type NormalEvent,
} from "@slopwatch/events";
import { resolveShipConfig } from "@slopwatch/config";
import {
  argvHelpers,
  createLiveListener,
  type ChildTail,
} from "@slopwatch/listener-shared";
import { childSessionMarkers, createCodexAdapter } from "./adapter";
import { sessionIdFromFilename } from "./normalizer";

const { arg, numArg } = argvHelpers(process.argv.slice(2));

const file = arg("file");
const sessionId =
  arg("session-id") ?? sessionIdFromFilename(file ?? "") ?? "unknown-session";
// argv pair wins for manual runs; otherwise the central config written by
// `slopwatch install` (the installed hook carries no credentials at all)
const ship = resolveShipConfig({
  serverUrl: arg("server-url"),
  token: arg("token"),
});

if (!file) {
  console.error(
    "usage: bun live.ts --file <rollout> --session-id <thread-uuid> [--server-url U --token T]  (server-url/token default to ~/.slopwatch/config.json)",
  );
  process.exit(1);
}

// --- Subagent capture ---------------------------------------------------------

const ROLLOUT_DIR = dirname(file);
// plain .jsonl only — a .jsonl.zst sibling is the 7-day cold-compressed copy
const ROLLOUT_FILE =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;
const cwd = arg("cwd") ?? process.cwd();
const gitRemote = arg("git-remote");

const claimedFiles = new Set<string>();

/**
 * The first record of a rollout file — always the session_meta (line 0) and
 * all the claim decision gets. A file caught mid-write can end without a
 * newline: null means "not yet decidable" and the poll simply retries.
 */
const firstRecord = (path: string): Record<string, unknown> | null => {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    let buf = Buffer.alloc(0);
    const chunk = Buffer.alloc(256 * 1024);
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, buf.length);
      if (n <= 0) return null;
      buf = Buffer.concat([buf, chunk.subarray(0, n)]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (buf.length > 8 * 1024 * 1024) return null;
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(
          buf.subarray(0, nl).toString("utf8"),
        );
        return isObject(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
  } finally {
    closeSync(fd);
  }
};

const adapterApi = createCodexAdapter({ primarySessionId: sessionId });
const adapter = adapterApi.adapter;

const childTails = {
  discover: (): ChildTail[] => {
    let names: string[];
    try {
      names = readdirSync(ROLLOUT_DIR);
    } catch {
      return []; // the date directory vanished (rotation?) — nothing to claim
    }
    const tails: ChildTail[] = [];
    for (const name of names) {
      const match = name.match(ROLLOUT_FILE);
      if (!match || name === basename(file) || claimedFiles.has(name)) continue;
      const path = join(ROLLOUT_DIR, name);
      const meta = firstRecord(path);
      const payload = meta && isObject(meta.payload) ? meta.payload : null;
      if (!payload) continue; // first line still mid-write — retry next tick
      const isSubagent =
        payload.thread_source === "subagent" ||
        (isObject(payload.source) && isObject(payload.source.subagent));
      if (!isSubagent) continue;
      // claim only direct children of THIS thread (session-scoped, so two
      // concurrently open root sessions never cross-adopt each other's
      // subagents); the fallback keys on the shared root session id
      const spawn = isObject(payload.source)
        ? isObject(payload.source.subagent)
          ? isObject(payload.source.subagent.thread_spawn)
            ? payload.source.subagent.thread_spawn
            : null
          : null
        : null;
      const parentId =
        spawn && isNonEmptyString(spawn.parent_thread_id)
          ? spawn.parent_thread_id
          : null;
      const rootId = isNonEmptyString(payload.session_id)
        ? payload.session_id
        : null;
      if (parentId !== sessionId && rootId !== sessionId) continue;
      const childId = isNonEmptyString(payload.id)
        ? payload.id
        : ((match[1] ?? "").split("_")[0] ?? "");
      if (!childId) continue;
      claimedFiles.add(name);
      const startedAt =
        meta && isNonEmptyString(meta.timestamp)
          ? meta.timestamp
          : new Date().toISOString();
      const markers = childSessionMarkers({
        childId,
        // a grandchild's real parent is the child thread — attribute honestly
        parentId: parentId ?? sessionId,
        ...(parentId === sessionId
          ? { spawnedByTurnId: adapterApi.primaryTurnId() ?? undefined }
          : {}),
        cwd,
        hostname: hostname(),
        gitRemote,
        startedAt,
      });
      tails.push({
        file: path,
        sessionId: childId,
        onStart: (): NormalEvent[] => [markers.start],
        onEnd: (reason: string): NormalEvent[] => [markers.end(reason)],
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
  agent: "codex",
  file,
  sessionId,
  cwd,
  // the hook resolves the git remote from its own cwd and passes it along
  gitRemote,
  // 5 minutes (decision 19): a long tool call must not idle-end the listener
  // mid-turn — PostToolUse/Stop re-spawns cover the genuinely dead case
  idleMs: numArg("idle-ms", 300_000),
  maxLifetimeMs: numArg("max-lifetime-ms", 4 * 60 * 60 * 1000),
  serverUrl: ship?.serverUrl,
  token: ship?.token,
  adapter,
  childTails,
  heartbeat: true,
  // the fold is cheap to attempt: no healthz gate, a lost POST costs nothing
  // the queue has not already preserved (SessionEnd hook exists, like
  // Claude Code)
  probeBeforeFold: false,
  drainScript: fileURLToPath(new URL("./drain.ts", import.meta.url)),
});
