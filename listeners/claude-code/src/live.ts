/**
 * Live-tail a Claude Code transcript and emit normalized events — NDJSON on
 * stdout, or POST batches to a Slopwatch server when --server-url/--token are
 * given. Backfills the existing file first, then watches for appends. Claude
 * Code HAS a SessionEnd hook (the hook script ships session:end and stops the
 * listener), so idle timeout is only the fallback for lost end events.
 *
 * Usage: bun live.ts --file <transcript> --session-id <id> [--cwd <dir>]
 *        [--git-remote URL] [--idle-ms 120000] [--max-lifetime-ms 14400000]
 *        [--server-url http://host:port --token <bearer>]
 */
import { existsSync, mkdirSync, watch } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  envelope,
  type NormalEvent,
  type SessionStartEvent,
} from "@slopwatch/events";
import { loadConfig, resolveShipConfig } from "@slopwatch/config";
import { foldSummary, summaryStore } from "@slopwatch/summary";
import {
  argvHelpers,
  createShipPipeline,
  createTailLoop,
  createTurnDigest,
  spawnDrainSweep,
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

const stateDir = join(homedir(), ".slopwatch", "listeners");
const cursorFile = join(stateDir, `claude-code-${sessionId}.cursor`);
mkdirSync(stateDir, { recursive: true });
const stateBase = cursorFile.slice(0, -".cursor".length);
const summaries = summaryStore(stateBase);

const sweep = (): void =>
  spawnDrainSweep(fileURLToPath(new URL("./drain.ts", import.meta.url)));
const { flush } = createShipPipeline({
  agent: "claude-code",
  sessionId,
  serverUrl,
  token,
  stateBase,
  onQueued: sweep,
});

// Rolling summaries (open question 15): only while shipping, only with a
// configured summary block — no key means silent skip, capture unaffected.
const summaryLlm = serverUrl ? loadConfig()?.summary : undefined;

const digest = createTurnDigest(summaries);

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

let idleTimer: ReturnType<typeof setTimeout>;
const resetIdle = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void finish("idle-timeout"), idleMs);
};

const { drain } = createTailLoop({
  file,
  cursorFile,
  agent: "claude-code",
  sessionId,
  adapter,
  digest,
  flush,
  resetIdle,
});

let finished = false;
const finish = async (reason: string): Promise<void> => {
  if (finished) return;
  finished = true;
  clearTimeout(idleTimer);
  // fold the summary first so summary → end ships in one POST; an LLM
  // failure leaves the digests pending and only costs this end's summary
  digest.close();
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
      else if (summaries.pendingDigests().length > 0) {
        console.error(
          "live: fold returned no summary — digests kept for the next end",
        );
      }
    } catch (e) {
      console.error(
        `live: summary fold skipped (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }
  batch.push({
    ...envelope("claude-code", sessionId, new Date().toISOString()),
    kind: "session",
    event: "end",
    reason,
  });
  await flush(batch);
  // grace period so in-flight POSTs can complete before exiting
  setTimeout(() => process.exit(0), serverUrl ? 1500 : 50);
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
    ...envelope("claude-code", sessionId, new Date().toISOString()),
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
