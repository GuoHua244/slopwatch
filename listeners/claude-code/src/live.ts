/**
 * Live-tail a Claude Code transcript and emit normalized events — NDJSON on
 * stdout, or POST batches to a Slopwatch server when --server-url/--token are
 * given. Backfills the existing file first, then watches for appends. Claude
 * Code HAS a SessionEnd hook (the hook script ships session:end and stops the
 * sidecar), so idle timeout is only the fallback for lost end events.
 *
 * Usage: bun live.ts --file <transcript> --session-id <id> [--cwd <dir>]
 *        [--git-remote URL] [--idle-ms 120000] [--max-lifetime-ms 14400000]
 *        [--server-url http://host:port --token <bearer>]
 */
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
import { join } from "node:path";
import {
  SCHEMA_VERSION,
  isNormalEvent,
  sendEvents,
  type NormalEvent,
  type SessionEndEvent,
  type SessionStartEvent,
} from "@slopwatch/events";
import { readCursor, writeCursor } from "./cursor";
import { eventsFromRecord, metaFromRecord, newTailState } from "./normalizer";

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const numArg = (name: string, dflt: number): number => {
  const n = Number(arg(name));
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

const file = arg("file");
const sessionId = arg("session-id") ?? "unknown-session";
const cwd = arg("cwd") ?? process.cwd();
const gitRemote = arg("git-remote");
const idleMs = numArg("idle-ms", 120_000);
const maxLifetimeMs = numArg("max-lifetime-ms", 4 * 60 * 60 * 1000);
const serverUrl = arg("server-url");
const token = arg("token");

if (!file) {
  console.error(
    "usage: bun live.ts --file <transcript> --session-id <id> [--server-url U --token T]",
  );
  process.exit(1);
}

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
    agent: "claude-code",
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

const stateDir = join(homedir(), ".slopwatch", "listeners");
const cursorFile = join(stateDir, `claude-code-${sessionId}.cursor`);
mkdirSync(stateDir, { recursive: true });
// resume from the previous sidecar generation's offset (0 on first capture)
let size = readCursor(cursorFile);
let partial = "";
const state = newTailState();
let draining = false;
const drain = async (): Promise<void> => {
  if (draining) return; // previous flush still in flight
  draining = true;
  try {
    let current: number;
    try {
      current = statSync(file!).size;
    } catch {
      return; // file vanished — keep waiting
    }
    if (current < size) {
      size = 0; // file truncated/rewritten — start over
      partial = "";
    }
    if (current === size) return;
    const fd = openSync(file!, "r");
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
      batch.push(...eventsFromRecord(record, sessionId, state));
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
  watch(file!, () => void drain());
  setInterval(() => void drain(), 2000); // belt-and-braces alongside fs.watch
  setTimeout(() => finish("max-lifetime"), maxLifetimeMs);
};

// Land session:start BEFORE any drained record can flush, so the event
// stream begins with the session envelope rather than a race.
const init = async (): Promise<void> => {
  // Every generation opens with its own start: after an idle-timeout end the
  // re-spawn must re-assert start so the dashboard's last-end-wins status
  // flips the session back to live.
  const startEvent: SessionStartEvent = {
    schema_version: SCHEMA_VERSION,
    agent: "claude-code",
    session_id: sessionId,
    occurred_at: new Date().toISOString(),
    kind: "session",
    event: "start",
    cwd,
    hostname: hostname(),
    ...(gitRemote ? { git_remote: gitRemote } : {}),
  };
  await flush([startEvent]);
  resetIdle();
  if (existsSync(file!)) {
    start();
  } else {
    // SessionStart can fire before the first transcript write — wait for it.
    const poll = setInterval(() => {
      if (existsSync(file!)) {
        clearInterval(poll);
        start();
      }
    }, 500);
  }
};
void init();
