/**
 * Live-tail a ZCode rollout file and emit normalized events — NDJSON on stdout,
 * or POST batches to a Slopwatch server when --server-url/--token are given.
 * Backfills the existing file first, then watches for appends. ZCode has no
 * SessionEnd hook, so the listener exits after --idle-ms without new records
 * (capped at --max-lifetime-ms).
 *
 * Usage: bun live.ts (--file <rollout> | --session-id <id>)
 *        [--idle-ms 300000] [--max-lifetime-ms 14400000]
 *        [--server-url http://host:port --token <bearer>] [--cwd <dir>]
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, watch, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { envelope, type NormalEvent } from "@slopwatch/events";
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
const idleMs = numArg("idle-ms", 300_000);
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

const stateDir = join(homedir(), ".slopwatch", "listeners");
const cursorFile = join(stateDir, `zcode-${sessionId}.cursor`);
mkdirSync(stateDir, { recursive: true });
const stateBase = cursorFile.slice(0, -".cursor".length);
const summaries = summaryStore(stateBase);

const sweep = (): void =>
  spawnDrainSweep(fileURLToPath(new URL("./drain.ts", import.meta.url)));
const { flush } = createShipPipeline({
  agent: "zcode",
  sessionId,
  serverUrl,
  token,
  stateBase,
  onQueued: sweep,
});

// Rolling summaries (open question 15): only while shipping, only with a
// configured summary block — no key means silent skip, capture unaffected.
const summaryLlm = serverUrl ? loadConfig()?.summary : undefined;

const serverReachable = async (url: string): Promise<boolean> => {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/healthz`, {
      signal: AbortSignal.timeout(2_500),
    });
    return res.ok;
  } catch {
    return false;
  }
};

// Liveness heartbeat for the spawner's respawn decision: Windows reuses PIDs,
// so signal-0 alone can mistake a dead listener for a live one — the freshness
// of this file is what actually proves we are running.
const heartbeatFile = `${stateBase}.heartbeat`;
const touchHeartbeat = (): void =>
  writeFileSync(heartbeatFile, String(Date.now()));
touchHeartbeat();
const heartbeatTimer = setInterval(touchHeartbeat, 30_000);

const digest = createTurnDigest(summaries);

let idleTimer: ReturnType<typeof setTimeout>;
const resetIdle = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void finish("idle-timeout"), idleMs);
};

// ZCode rollout records carry everything worth capturing: title/task preview,
// the first record of each turn, the model-request/tool-call stream, and the
// results of earlier tool calls (echoed in the next request's messages).
const seenTurns = new Set<string>();
const seenToolResults = new Set<string>();
let taskPreviewSent = false;
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
    const turnStart = turnStartFromRecord(record, sessionId, seenTurns);
    if (turnStart) events.push(turnStart);
    events.push(...eventsFromRecord(record, sessionId));
    events.push(...toolResultsFromRecord(record, sessionId, seenToolResults));
    return events;
  },
};

const { drain } = createTailLoop({
  file,
  cursorFile,
  agent: "zcode",
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
  clearInterval(heartbeatTimer);
  digest.close();
  // fold the summary first so summary → end ships in one POST; an LLM
  // failure leaves the digests pending and only costs this end's summary.
  // Tokens are only worth spending when the result can actually ship:
  // probe the server first, because a fold computed offline is lost with
  // the failed POST and re-burned on the next end.
  const shipable =
    summaryLlm && serverUrl ? await serverReachable(serverUrl) : false;
  if (summaryLlm && !shipable) {
    console.error(
      "live: server unreachable — summary fold skipped, digests kept for retry",
    );
  }
  const batch: NormalEvent[] = [];
  if (summaryLlm && shipable) {
    try {
      const summaryEvent = await foldSummary({
        stateBase,
        agent: "zcode",
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
    ...envelope("zcode", sessionId, new Date().toISOString()),
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
  watch(file, () => void drain());
  setInterval(() => void drain(), 2000); // belt-and-braces alongside fs.watch
  setTimeout(() => void finish("max-lifetime"), maxLifetimeMs);
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

// Every generation opens with its own start: the listener re-spawns after each
// idle-timeout end, and the dashboard's last-end-wins status needs a fresh
// start to flip the session back to live.
void flush([
  {
    ...envelope("zcode", sessionId, new Date().toISOString()),
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
