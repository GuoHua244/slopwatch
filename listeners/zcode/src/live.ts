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
import { eventsFromRecord, sessionIdFromFilename } from "./normalizer";

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
const serverUrl = arg("server-url");
const token = arg("token");

if (!file) {
  console.error(
    "usage: bun live.ts (--file <rollout> | --session-id <id>) [--idle-ms N] [--max-lifetime-ms N] [--server-url U --token T]",
  );
  process.exit(1);
}

const sessionId =
  sessionIdArg ?? sessionIdFromFilename(basename(file)) ?? "unknown-session";

const emit = (event: NormalEvent): void => {
  if (!isNormalEvent(event)) {
    console.error(
      "live: skipping invalid event:",
      JSON.stringify(event).slice(0, 200),
    );
    return;
  }
  if (serverUrl && token) {
    sendEvents([event], { serverUrl, token }).catch((e: unknown) => {
      // v0 behavior (open question 4): drop on failure, keep tailing
      console.error(
        `live: dropped batch (${e instanceof Error ? e.message : String(e)})`,
      );
    });
  } else {
    console.log(JSON.stringify(event));
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
  emit(end);
  // grace period so in-flight POSTs can complete before exiting
  setTimeout(() => process.exit(0), serverUrl ? 1500 : 50);
};

let idleTimer: ReturnType<typeof setTimeout>;
const resetIdle = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => finish("idle-timeout"), idleMs);
};

let size = 0;
let partial = "";
const drain = (): void => {
  let current: number;
  try {
    current = statSync(file).size;
  } catch {
    return; // file vanished (rotated?) — keep waiting
  }
  if (current <= size) return;
  const fd = openSync(file, "r");
  const buf = Buffer.alloc(current - size);
  readSync(fd, buf, 0, buf.length, size);
  closeSync(fd);
  size = current;
  partial += buf.toString("utf8");
  const lines = partial.split("\n");
  partial = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      console.error("live: skipping unparsable line");
      continue;
    }
    for (const event of eventsFromRecord(record, sessionId)) emit(event);
    resetIdle();
  }
};

const start = () => {
  drain(); // backfill everything written before we attached
  watch(file, () => drain());
  setInterval(drain, 2000); // belt-and-braces alongside fs.watch
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

emit({
  schema_version: SCHEMA_VERSION,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: new Date().toISOString(),
  kind: "session",
  event: "start",
  cwd: arg("cwd") ?? process.cwd(),
  hostname: hostname(),
  git_remote: gitRemote,
});
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
