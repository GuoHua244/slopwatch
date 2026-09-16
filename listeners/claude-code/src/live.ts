/**
 * Live-tail a Claude Code transcript and emit normalized events — NDJSON on
 * stdout, or POST batches to a Slopwatch server when --server-url/--token are
 * given. Backfills the existing file first, then watches for appends. Claude
 * Code HAS a SessionEnd hook (the hook script ships session:end and stops the
 * listener), so idle timeout is only the fallback for lost end events.
 *
 * The tail/watch/teardown skeleton lives in listener-shared's
 * createLiveListener; this file is only the Claude Code adapter.
 *
 * Usage: bun live.ts --file <transcript> --session-id <id> [--cwd <dir>]
 *        [--git-remote URL] [--idle-ms 300000] [--max-lifetime-ms 14400000]
 *        [--server-url http://host:port --token <bearer>]
 */
import { fileURLToPath } from "node:url";
import { resolveShipConfig } from "@slopwatch/config";
import {
  argvHelpers,
  createLiveListener,
  type RecordAdapter,
} from "@slopwatch/listener-shared";
import {
  driftFromRecord,
  eventsFromRecord,
  metaFromRecord,
  newTailState,
} from "./normalizer";

const { arg, numArg } = argvHelpers(process.argv.slice(2));

const file = arg("file");
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

// Claude Code transcript records: drift detection, title/meta, and the
// request/tool stream (turn starts come from the transcript's own events).
const tailState = newTailState();
const adapter: RecordAdapter = {
  driftFromRecord,
  eventsFromRecord: (record, sessionId) => {
    const meta = metaFromRecord(record, sessionId);
    const events = eventsFromRecord(record, sessionId, tailState);
    return meta ? [meta, ...events] : events;
  },
};

await createLiveListener({
  agent: "claude-code",
  file,
  sessionId: arg("session-id") ?? "unknown-session",
  cwd: arg("cwd") ?? process.cwd(),
  // the hook resolves the git remote from its own cwd and passes it along
  gitRemote: arg("git-remote"),
  // 5 minutes (as ZCode's decision-19 fix): a long tool call must not idle-end
  // the listener mid-turn — PostToolUse re-spawns cover the genuinely dead case.
  idleMs: numArg("idle-ms", 300_000),
  maxLifetimeMs: numArg("max-lifetime-ms", 4 * 60 * 60 * 1000),
  serverUrl: ship?.serverUrl,
  token: ship?.token,
  adapter,
  heartbeat: true,
  // the fold is cheap to attempt: no healthz gate, a lost POST costs nothing
  // the queue has not already preserved
  probeBeforeFold: false,
  drainScript: fileURLToPath(new URL("./drain.ts", import.meta.url)),
});
