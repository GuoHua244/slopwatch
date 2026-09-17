/**
 * Live-tail a ZCode rollout file and emit normalized events — NDJSON on stdout,
 * or POST batches to a Slopwatch server when --server-url/--token are given.
 * Backfills the existing file first, then watches for appends. ZCode has no
 * SessionEnd hook, so the listener exits after --idle-ms without new records
 * (capped at --max-lifetime-ms).
 *
 * The tail/watch/teardown skeleton lives in listener-shared's
 * createLiveListener; this file is only the ZCode adapter.
 *
 * Usage: bun live.ts (--file <rollout> | --session-id <id>)
 *        [--idle-ms 300000] [--max-lifetime-ms 14400000]
 *        [--server-url http://host:port --token <bearer>] [--cwd <dir>]
 */
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AttachmentEvent, type NormalEvent } from "@slopwatch/events";
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
  sessionIdFromFilename,
  taskPreviewFromRecord,
  toolResultsFromRecord,
  turnStartFromRecord,
} from "./normalizer";

const { arg, numArg } = argvHelpers(process.argv.slice(2));

const sessionIdArg = arg("session-id");
const file =
  arg("file") ??
  (sessionIdArg
    ? join(
        homedir(),
        ".zcode",
        "cli",
        "rollout",
        `model-io-${sessionIdArg}.jsonl`,
      )
    : undefined);
// argv pair wins for manual runs; otherwise the central config written by
// `slopwatch install` (the installed hook carries no credentials at all)
const ship = resolveShipConfig({
  serverUrl: arg("server-url"),
  token: arg("token"),
});

if (!file) {
  console.error(
    "usage: bun live.ts (--file <rollout> | --session-id <id>) [--idle-ms N] [--max-lifetime-ms N] [--server-url U --token T]  (server-url/token default to ~/.slopwatch/config.json)",
  );
  process.exit(1);
}

const sessionId =
  sessionIdArg ?? sessionIdFromFilename(basename(file)) ?? "unknown-session";

let gitRemote: string | undefined;
try {
  const remote = execSync("git remote get-url origin", {
    encoding: "utf8",
    cwd: arg("cwd"),
  }).trim();
  if (remote) gitRemote = remote;
} catch {
  // optional
}

// ZCode rollout records carry everything worth capturing: title/task preview,
// the first record of each turn, the model-request/tool-call stream, and the
// results of earlier tool calls (echoed in the next request's messages).
const seenTurns = new Set<string>();
const seenToolResults = new Set<string>();
const seenImages = new Set<string>();
let taskPreviewSent = false;
const recordOccurredAt = (record: unknown): string =>
  typeof record === "object" &&
  record !== null &&
  typeof (record as { completedAt?: unknown }).completedAt === "string"
    ? (record as { completedAt: string }).completedAt
    : new Date().toISOString();
const adapter: RecordAdapter = {
  driftFromRecord,
  eventsFromRecord: (record, sessionId) => {
    const events: NormalEvent[] = [];
    const meta = metaFromRecord(record, sessionId);
    if (meta) events.push(meta);
    if (!taskPreviewSent) {
      const preview = taskPreviewFromRecord(record, sessionId);
      if (preview) {
        events.push(preview);
        taskPreviewSent = true;
      }
    }
    // Attachment events ride ahead of the referencing turn/tool event, and
    // the seen-sha set keeps history re-echoes from re-shipping bytes.
    const capture = {
      sessionId,
      occurredAt: recordOccurredAt(record),
      seen: seenImages,
      attachments: [] as AttachmentEvent[],
    };
    const turnStart = turnStartFromRecord(
      record,
      sessionId,
      seenTurns,
      capture,
    );
    events.push(...capture.attachments.splice(0));
    if (turnStart) events.push(turnStart);
    events.push(...eventsFromRecord(record, sessionId));
    const toolResults = toolResultsFromRecord(
      record,
      sessionId,
      seenToolResults,
      capture,
    );
    events.push(...capture.attachments.splice(0));
    events.push(...toolResults);
    return events;
  },
};

await createLiveListener({
  agent: "zcode",
  file,
  sessionId,
  cwd: arg("cwd") ?? process.cwd(),
  gitRemote,
  idleMs: numArg("idle-ms", 300_000),
  maxLifetimeMs: numArg("max-lifetime-ms", 4 * 60 * 60 * 1000),
  serverUrl: ship?.serverUrl,
  token: ship?.token,
  adapter,
  heartbeat: true,
  // ZCode's end is usually the idle/max-lifetime exit with the server maybe
  // gone — probe first so tokens are not burned on a summary that cannot ship
  probeBeforeFold: true,
  drainScript: fileURLToPath(new URL("./drain.ts", import.meta.url)),
});
