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
  type SessionStartEvent,
} from "@slopwatch/events";
import { loadConfig, resolveShipConfig } from "@slopwatch/config";
import { foldSummary, summaryStore } from "@slopwatch/summary";
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
    "usage: bun live.ts --file <transcript> --session-id <id> [--server-url U --token T]  (server-url/token default to ~/.slopwatch/config.json)",
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

// Rolling summaries (open question 15): only while shipping, only with a
// configured summary block — no key means silent skip, capture unaffected.
const summaryLlm = serverUrl ? loadConfig()?.summary : undefined;

let finished = false;
const finish = async (reason: string): Promise<void> => {
  if (finished) return;
  finished = true;
  clearTimeout(idleTimer);
  // fold the summary first so summary → end ships in one POST; an LLM
  // failure leaves the digests pending and only costs this end's summary
  closeTurnDigest();
  const batch: NormalEvent[] = [];
  if (summaryLlm) {
    try {
      const summaryEvent = await foldSummary({
        stateBase,
        agent: "claude-code",
        sessionId,
        llm: summaryLlm,
      });
      if (summaryEvent) batch.push(summaryEvent);
    } catch (e) {
      console.error(
        `live: summary fold skipped (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }
  batch.push({
    schema_version: SCHEMA_VERSION,
    agent: "claude-code",
    session_id: sessionId,
    occurred_at: new Date().toISOString(),
    kind: "session",
    event: "end",
    reason,
  });
  await flush(batch);
  // grace period so in-flight POSTs can complete before exiting
  setTimeout(() => process.exit(0), serverUrl ? 1500 : 50);
};

let idleTimer: ReturnType<typeof setTimeout>;
const resetIdle = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void finish("idle-timeout"), idleMs);
};

const stateDir = join(homedir(), ".slopwatch", "listeners");
const cursorFile = join(stateDir, `claude-code-${sessionId}.cursor`);
mkdirSync(stateDir, { recursive: true });
const stateBase = cursorFile.slice(0, -".cursor".length);
const summaries = summaryStore(stateBase);

// Rolling digest of the turn in progress — appended to the summary log when
// the turn closes (the next real user prompt, or the session end).
const fmtTokens = (n: number): string =>
  n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
let currentTurn: {
  user: string;
  requests: number;
  inTokens: number;
  outTokens: number;
  tools: string[];
} | null = null;
const closeTurnDigest = (): void => {
  if (!currentTurn) return;
  const t = currentTurn;
  // cumulative ordinal: everything folded so far plus pending log entries
  const ordinal =
    (summaries.loadCache()?.folded ?? 0) +
    summaries.pendingDigests().length +
    1;
  const parts = [
    `turn ${ordinal}: "${t.user.slice(0, 160)}"`,
    `${t.requests} model request${t.requests === 1 ? "" : "s"} (${fmtTokens(t.inTokens)} in / ${fmtTokens(t.outTokens)} out)`,
    t.tools.length > 0 ? `tools: ${t.tools.join(", ")}` : "",
  ].filter(Boolean);
  summaries.appendDigest(parts.join(" · "));
  currentTurn = null;
};
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
      const recordEvents = eventsFromRecord(record, sessionId, state);
      batch.push(...recordEvents);
      for (const e of recordEvents) {
        if (e.kind === "turn" && e.event === "start") {
          closeTurnDigest();
          currentTurn = {
            user: e.user_message ?? "(no user message text)",
            requests: 0,
            inTokens: 0,
            outTokens: 0,
            tools: [],
          };
        } else if (e.kind === "model_request") {
          if (currentTurn === null)
            currentTurn = {
              user: "(turn started before capture attached)",
              requests: 0,
              inTokens: 0,
              outTokens: 0,
              tools: [],
            };
          currentTurn.requests += 1;
          currentTurn.inTokens += e.usage?.input_tokens ?? 0;
          currentTurn.outTokens += e.usage?.output_tokens ?? 0;
        } else if (e.kind === "tool" && e.event === "call") {
          if (currentTurn !== null && currentTurn.tools.length < 8)
            currentTurn.tools.push(e.tool);
        }
      }
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
  setTimeout(() => void finish("max-lifetime"), maxLifetimeMs);
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
