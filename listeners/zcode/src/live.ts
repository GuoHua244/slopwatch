/**
 * Live-tail a ZCode rollout file and emit normalized events — NDJSON on stdout,
 * or POST batches to a Slopwatch server when --server-url/--token are given.
 * Backfills the existing file first, then watches for appends. ZCode has no
 * SessionEnd hook, so the sidecar exits after --idle-ms without new records
 * (capped at --max-lifetime-ms).
 *
 * Usage: bun live.ts (--file <rollout> | --session-id <id>)
 *        [--idle-ms 120000] [--max-lifetime-ms 14400000]
 *        [--server-url http://host:port --token <bearer>] [--cwd <dir>]
 */
import { execSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  watch,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import {
  SCHEMA_VERSION,
  isNormalEvent,
  sendEvents,
  type NormalEvent,
  type SessionEndEvent,
} from "@slopwatch/events";
import { resolveShipConfig } from "@slopwatch/config";
import { readCursor, writeCursor } from "./cursor";
import {
  eventsFromRecord,
  metaFromRecord,
  sessionIdFromFilename,
  taskPreviewFromRecord,
  turnStartFromRecord,
} from "./normalizer";

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const numArg = (name: string, dflt: number): number => {
  const n = Number(arg(name));
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

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
const idleMs = numArg("idle-ms", 120_000);
const maxLifetimeMs = numArg("max-lifetime-ms", 4 * 60 * 60 * 1000);
// argv pair wins for manual runs; otherwise the central config written by
// `slopwatch install` (the installed hook carries no credentials at all)
const ship = resolveShipConfig({
  serverUrl: arg("server-url"),
  token: arg("token"),
});
const serverUrl = ship?.serverUrl;
const token = ship?.token;

if (!file) {
  console.error(
    "usage: bun live.ts (--file <rollout> | --session-id <id>) [--idle-ms N] [--max-lifetime-ms N] [--server-url U --token T]  (server-url/token default to ~/.slopwatch/config.json)",
  );
  process.exit(1);
}

const sessionId =
  sessionIdArg ?? sessionIdFromFilename(basename(file)) ?? "unknown-session";

/**
 * Send a batch. In server mode a failed POST exits the process WITHOUT
 * advancing the cursor: the UserPromptSubmit re-spawn resumes from the last
 * committed offset and re-sends the backlog — read progress always equals
 * send progress, so nothing is lost and nothing is sent twice.
 */
const flush = async (batch: NormalEvent[]): Promise<void> => {
  if (batch.length === 0) return;
  const valid = batch.filter(isNormalEvent);
  for (const event of batch) {
    if (!isNormalEvent(event)) {
      console.error(
        "live: skipping invalid event:",
        JSON.stringify(event).slice(0, 200),
      );
    }
  }
  if (serverUrl && token) {
    try {
      await sendEvents(valid, { serverUrl, token });
    } catch (e) {
      console.error(
        `live: server unreachable (${e instanceof Error ? e.message : String(e)}) — exiting; re-spawn resumes from cursor`,
      );
      process.exit(1);
    }
  } else {
    for (const event of valid) console.log(JSON.stringify(event));
  }
};

let finished = false;
const finish = (reason: string): void => {
  if (finished) return;
  finished = true;
  const end: SessionEndEvent = {
    schema_version: SCHEMA_VERSION,
    agent: "zcode",
    session_id: sessionId,
    occurred_at: new Date().toISOString(),
    kind: "session",
    event: "end",
    reason,
  };
  void flush([end]);
  // grace period so in-flight POSTs can complete before exiting
  setTimeout(() => process.exit(0), serverUrl ? 1500 : 50);
};

let idleTimer: ReturnType<typeof setTimeout>;
const resetIdle = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => finish("idle-timeout"), idleMs);
};

const cursorFile = join(
  homedir(),
  ".slopwatch",
  "listeners",
  `zcode-${sessionId}.cursor`,
);
mkdirSync(join(homedir(), ".slopwatch", "listeners"), { recursive: true });
// resume from the previous sidecar generation's offset (0 on first capture)
let size = readCursor(cursorFile);
let partial = "";
let taskPreviewSent = false;
const seenTurns = new Set<string>();
let draining = false;
const drain = async (): Promise<void> => {
  if (draining) return; // previous flush still in flight
  draining = true;
  try {
    let current: number;
    try {
      current = statSync(file).size;
    } catch {
      return; // file vanished (rotated?) — keep waiting
    }
    if (current < size) {
      size = 0; // file truncated/rotated — start over
      partial = "";
    }
    if (current === size) return;
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(current - size);
    readSync(fd, buf, 0, buf.length, size);
    closeSync(fd);
    size = current;
    partial += buf.toString("utf8");
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    const batch: NormalEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        console.error("live: skipping unparsable line");
        continue;
      }
      const meta = metaFromRecord(record, sessionId);
      if (meta) batch.push(meta);
      if (!taskPreviewSent) {
        const preview = taskPreviewFromRecord(record, sessionId);
        if (preview) {
          batch.push(preview);
          taskPreviewSent = true;
        }
      }
      const turnStart = turnStartFromRecord(record, sessionId, seenTurns);
      if (turnStart) batch.push(turnStart);
      batch.push(...eventsFromRecord(record, sessionId));
      resetIdle();
    }
    await flush(batch);
    // committed only AFTER a successful send, and only up to the end of the
    // last COMPLETE line — a partially-written trailing line is re-read next
    // time so it can be stitched back together
    writeCursor(cursorFile, size - Buffer.byteLength(partial));
  } finally {
    draining = false;
  }
};

const start = () => {
  void drain(); // backfill everything written before we attached
  watch(file, () => void drain());
  setInterval(() => void drain(), 2000); // belt-and-braces alongside fs.watch
  setTimeout(() => finish("max-lifetime"), maxLifetimeMs);
};

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

// Every generation opens with its own start: the sidecar re-spawns after each
// idle-timeout end, and the dashboard's last-end-wins status needs a fresh
// start to flip the session back to live.
void flush([
  {
    schema_version: SCHEMA_VERSION,
    agent: "zcode",
    session_id: sessionId,
    occurred_at: new Date().toISOString(),
    kind: "session",
    event: "start",
    cwd: arg("cwd") ?? process.cwd(),
    hostname: hostname(),
    git_remote: gitRemote,
  },
]);
resetIdle();

if (existsSync(file)) {
  start();
} else {
  // SessionStart can fire before the first rollout write — wait for the file.
  const poll = setInterval(() => {
    if (existsSync(file)) {
      clearInterval(poll);
      start();
    }
  }, 500);
}
