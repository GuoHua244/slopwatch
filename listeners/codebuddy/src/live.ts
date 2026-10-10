/**
 * Poll a CodeBuddy conversation's history and emit normalized events — NDJSON
 * on stdout, or POST batches to a Slopwatch server when --server-url/--token
 * are given.
 *
 * This is NOT the shared tail skeleton: CodeBuddy's history is a manifest plus
 * one immutable file per message, not an appended JSONL, so there are no lines
 * to tail (research/codebuddy-capture-surfaces.md §2). What IS shared is
 * everything around the read loop — the ship pipeline and disk queue, the
 * liveness heartbeat, the graceful-stop handshake, the rolling summary fold,
 * the orphan sweep, and the idle/max-lifetime teardown. Only the drain itself
 * (`capture.ts`) and this wiring are CodeBuddy-specific.
 *
 * Lifecycle note: the measured host fires no SessionEnd/Stop hook at all, so
 * this listener decides when a session is over (idle · max-lifetime · a
 * graceful-stop marker from the hook). Each new generation re-asserts
 * `session.start`, so the dashboard's last-write-wins status flips back to
 * live when a quiet session comes alive again.
 *
 * Usage: bun live.ts --transcript-path <index.json> --session-id <id> [--cwd <dir>]
 *        [--git-remote URL] [--idle-ms 300000] [--max-lifetime-ms 14400000]
 *        [--server-url http://host:port --token <bearer>]
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  envelope,
  type NormalEvent,
  type SessionStartEvent,
} from "@slopwatch/events";
import { resolveShipConfig } from "@slopwatch/config";
import {
  argvHelpers,
  createShipPipeline,
  createSummaryFolder,
  createTurnDigest,
  spawnDrainSweep,
} from "@slopwatch/listener-shared";
import { AGENT } from "./normalizer";
import {
  conversationDir,
  conversationIndexPath,
  defaultHostRoots,
  resolveSurfaces,
  usageLogPath,
} from "./paths";
import { createCodebuddyCapture } from "./capture";

const { arg, numArg } = argvHelpers(process.argv.slice(2));

const transcriptPath = arg("transcript-path") ?? arg("file");
const sessionId = arg("session-id") ?? "unknown-session";
// argv pair wins for manual runs; otherwise the central config written by
// `slopwatch install` (the installed hook carries no credentials at all)
const ship = resolveShipConfig({
  serverUrl: arg("server-url"),
  token: arg("token"),
});

if (!transcriptPath && !arg("cwd")) {
  console.error(
    "usage: bun live.ts --transcript-path <history index.json> --session-id <id> [--server-url U --token T]  (or --cwd <workspace> to discover the newest conversation)",
  );
  process.exit(1);
}

const surfaces = resolveSurfaces({
  transcriptPath: transcriptPath ?? undefined,
  cwd: arg("cwd") ?? process.cwd(),
});
if (!surfaces) {
  console.error(
    `live: no CodeBuddy conversation found${arg("cwd") ? ` in ${arg("cwd")}` : ""} — nothing to capture. Is CodeBuddy's history under %LOCALAPPDATA%\\CodeBuddyExtension?`,
  );
  process.exit(1);
}

const cwd =
  surfaces.cwd.length > 0 ? surfaces.cwd : (arg("cwd") ?? process.cwd());

const stateDir = join(homedir(), ".slopwatch", "listeners");
mkdirSync(stateDir, { recursive: true });
const stateBase = join(stateDir, `${AGENT}-${sessionId}`);
/**
 * Graceful-stop handshake (the hook writes this file instead of relying on
 * signals — Windows cannot deliver SIGTERM to a detached process, ADR 0001,
 * and a hard kill would lose the held-back model requests and the end batch).
 */
const stopFile = `${stateBase}.stop`;
const pidFile = `${stateBase}.pid`;
const heartbeatFile = `${stateBase}.heartbeat`;

const sweep = (): void =>
  spawnDrainSweep(fileURLToPath(new URL("./drain.ts", import.meta.url)));

const { flush: flushBatch } = createShipPipeline({
  agent: AGENT,
  sessionId,
  serverUrl: ship?.serverUrl,
  token: ship?.token,
  stateBase,
  onQueued: sweep,
});

// Every flush source funnels through one promise chain: the flusher replays
// the disk queue before each batch, so concurrent callers would interleave
// replays and sends out of order.
let flushChain: Promise<unknown> = Promise.resolve();
const flush = (batch: NormalEvent[]): Promise<"sent" | "queued" | "stdout"> => {
  const next = flushChain.then(() => flushBatch(batch));
  flushChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
};

const folder = createSummaryFolder({
  agent: AGENT,
  sessionId,
  stateBase,
  serverUrl: ship?.serverUrl,
  token: ship?.token,
  // no healthz gate: a lost POST costs only this end's summary, and the
  // disk queue preserves anything that mattered
  probeBeforeFold: false,
});
const digest = createTurnDigest(folder.digests);

// Liveness heartbeat for the spawner's respawn decision: Windows reuses PIDs,
// so signal-0 alone can mistake a dead listener for a live one — the
// freshness of this file is what actually proves we are running.
const touchHeartbeat = (): void =>
  writeFileSync(heartbeatFile, String(Date.now()));
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
touchHeartbeat();
heartbeatTimer = setInterval(touchHeartbeat, 30_000);

const capture = createCodebuddyCapture({
  ref: surfaces.ref,
  sessionId,
  stateFile: `${stateBase}.history.json`,
  usageLog: surfaces.usageLog,
  // the log's day directory is created by the logger's first flush, which
  // can lag the hook that spawned us by minutes — keep re-resolving instead
  // of fixing a null (or yesterday's path, after midnight) at spawn
  resolveUsageLog: () =>
    usageLogPath({
      localAppData: defaultHostRoots().localAppData,
      workspaceHash: surfaces.ref.workspaceHash,
    }),
  // environment facts for sub-agent sessions: a child Session needs the same
  // dimensions as its parent, and only live.ts knows the workspace
  cwd,
  hostname: hostname(),
});

let idleTimer: ReturnType<typeof setTimeout>;
let lastActivityMs = Date.now();
const idleMs = numArg("idle-ms", 300_000);
const maxLifetimeMs = numArg("max-lifetime-ms", 4 * 60 * 60 * 1000);
const resetIdle = (): void => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void finish("idle-timeout"), idleMs);
};

let finished = false;
const finish = async (reason: string): Promise<void> => {
  if (finished) return;
  finished = true;
  clearTimeout(idleTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  // lifecycle files must not outlive the listener: a stale pid file would
  // make the next hook fire skip a needed respawn
  try {
    unlinkSync(pidFile);
  } catch {
    // already gone
  }
  try {
    unlinkSync(stopFile);
  } catch {
    // already gone
  }
  const teardownEvents = capture.teardown();
  digest.observe(teardownEvents);
  digest.close();
  const batch: NormalEvent[] = [...teardownEvents];
  try {
    const summaryEvent = await folder.fold();
    if (summaryEvent) batch.push(summaryEvent);
  } catch (e) {
    console.error(
      `live: summary fold skipped (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  batch.push({
    ...envelope(AGENT, sessionId, new Date().toISOString()),
    kind: "session",
    event: "end",
    reason,
  });
  await flush(batch);
  // grace period so in-flight POSTs can complete before exiting
  setTimeout(() => process.exit(0), ship?.serverUrl ? 1500 : 50);
};

const tick = (): void => {
  void (async () => {
    if (existsSync(stopFile)) {
      // hook-requested graceful stop. Only fresh markers count: a marker left
      // unconsumed by a listener that died before its next tick must not
      // insta-finish a respawn of the same session.
      let fresh = false;
      try {
        const writtenAt = Number(readFileSync(stopFile, "utf8").trim());
        fresh = Number.isFinite(writtenAt) && Date.now() - writtenAt < 30_000;
      } catch {
        fresh = false;
      }
      try {
        unlinkSync(stopFile);
      } catch {
        // already gone
      }
      if (fresh) {
        await finish("hook-stop");
        return;
      }
    }
    const events = capture.poll();
    let activity = events.length > 0;
    if (!activity) {
      // the manifest is rewritten on every assistant step even when nothing
      // of ours ships yet (e.g. a request waiting for its token counts)
      try {
        const mtimeMs = statSync(conversationIndexPath(surfaces.ref)).mtimeMs;
        activity = mtimeMs > lastActivityMs;
        if (activity) lastActivityMs = mtimeMs;
      } catch {
        // no manifest yet
      }
    } else {
      lastActivityMs = Date.now();
    }
    if (activity) {
      // every generation of events prolongs the session: a tool loop that
      // produces no new rows for five minutes is genuinely idle
      resetIdle();
    }
    if (events.length === 0) return;
    try {
      await flush(events);
    } catch (e) {
      // nothing shippable (queue write failed) — release the gates so the
      // cursor-rewound replay re-emits them instead of losing them
      capture.onFlushFailed(events);
      console.error(
        `live: flush failed (${e instanceof Error ? e.message : String(e)})`,
      );
      return;
    }
    // a queued batch is durable on disk and will replay — the title gate
    // commits either way, exactly like the tail loop's cursor
    capture.onFlushed(events);
    digest.observe(events);
  })().catch((e) =>
    console.error(
      `live: tick failed (${e instanceof Error ? e.message : String(e)})`,
    ),
  );
};

const start = (): void => {
  tick();
  // watch the directory, not a single file: a new message is a NEW file, and
  // the manifest is rewritten rather than appended
  watch(conversationDir(surfaces.ref), tick);
  setInterval(tick, 2000); // belt-and-braces alongside fs.watch
  setTimeout(() => void finish("max-lifetime"), maxLifetimeMs);
};

// Every generation opens with its own start: after an idle-timeout end the
// re-spawn must re-assert start so the dashboard's last-end-wins status flips
// the session back to live. It lands BEFORE any captured event can flush.
const startEvent: SessionStartEvent = {
  ...envelope(AGENT, sessionId, new Date().toISOString()),
  kind: "session",
  event: "start",
  cwd,
  hostname: hostname(),
  ...(arg("git-remote") ? { git_remote: arg("git-remote")! } : {}),
};
await flush([startEvent]);
resetIdle();

if (existsSync(conversationIndexPath(surfaces.ref))) {
  start();
} else {
  // the hook can fire before the first message file exists
  const poll = setInterval(() => {
    if (existsSync(conversationIndexPath(surfaces.ref))) {
      clearInterval(poll);
      start();
    }
  }, 500);
}
