/**
 * Live-tail a ZCode rollout file and emit normalized events — NDJSON on stdout,
 * or POST batches to a Slopwatch server when --server-url/--token are given.
 * Backfills the existing file first, then watches for appends. ZCode has no
 * SessionEnd hook, so the listener exits after --idle-ms without new records
 * (capped at --max-lifetime-ms).
 *
 * Subagent sessions are captured from their own rollout files
 * (`model-io-sess_subagent_agent_<uuid>.jsonl` in the same directory):
 * discovered on the poll cadence, claimed when the first record's traceId
 * matches this session's, tailed with their own cursor, and bracketed by
 * child session:start (with parent_session_id)/session:end markers so the
 * server's child-session rollups (ADR 0008) see them.
 *
 * The tail/watch/teardown skeleton lives in listener-shared's
 * createLiveListener; this file is only the ZCode adapter.
 *
 * Usage: bun live.ts (--file <rollout> | --session-id <id>)
 *        [--idle-ms 300000] [--max-lifetime-ms 14400000]
 *        [--server-url http://host:port --token <bearer>] [--cwd <dir>]
 */
import { execSync } from "node:child_process";
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  envelope,
  isNonEmptyString,
  isObject,
  type AttachmentEvent,
  type NormalEvent,
  type SessionEndEvent,
  type SessionMetaEvent,
  type SessionStartEvent,
  type TurnStartEvent,
} from "@slopwatch/events";
import { resolveShipConfig } from "@slopwatch/config";
import {
  argvHelpers,
  atomicWriteJson,
  createLiveListener,
  type ChildTail,
  type RecordAdapter,
} from "@slopwatch/listener-shared";
import {
  driftFromRecord,
  eventsFromRecord,
  metaFromRecord,
  sessionIdFromFilename,
  taskPreviewFromRecord,
  titleTextFromRecord,
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
    // the listener runs console-less (spawned detached from the hook) —
    // without this the git child gets a fresh VISIBLE console window that
    // flashes on every session open
    windowsHide: true,
  }).trim();
  if (remote) gitRemote = remote;
} catch {
  // optional
}

// --- Subagent capture -------------------------------------------------------
// ZCode writes each subagent's model traffic to its own rollout file
// (`model-io-sess_subagent_agent_<uuid>.jsonl`, querySource "subagent") and
// deletes it when the session ends — replay can never recover it, live tail
// is the only path. A subagent record's traceId equals its parent session's
// (verified session-scoped and constant across turns in the ZCode internal
// db), so a file is claimed for this listener only when its first record's
// traceId matches ours — two concurrently open main sessions never
// cross-adopt each other's subagents.

const ROLLOUT_DIR = dirname(file);
const SUBAGENT_FILE = /^model-io-(sess_subagent_agent_.+)\.jsonl$/;

const primarySessionId = sessionId;
let parentTraceId: string | null = null;
let spawnedByTurnId: string | undefined;
const claimedFiles = new Set<string>();

// --- Title gate ---------------------------------------------------------------
// ZCode rewrites the (usually unchanged) session_title record on every turn;
// a title ships only when it differs from the last one DELIVERED. State is
// one sidecar per listener (primary plus child sessions) so a respawn stays
// gated, and the gate commits on the flush ack (listener-shared's tail.ts
// calls onFlushed/onFlushFailed) — a batch that never shipped must not gate
// its own retry.
const stateDir = join(homedir(), ".slopwatch", "listeners");
const titlesFile = join(stateDir, `zcode-${sessionId}.titles.json`);
const titleSent = new Map<string, string>(); // delivered, per session
const pendingTitle = new Map<string, string>(); // emitted, not yet acked
// Sessions whose delivered-title value came from a version-1 sidecar, which
// stored the event's 200-char truncated form. The gate then also suppresses
// a rewrite whose event form matches — it would re-ship byte-identical
// bytes — and adopts the full title on the spot, retiring the flag.
const legacyGate = new Set<string>();
try {
  const snapshot: unknown = JSON.parse(readFileSync(titlesFile, "utf8"));
  // a version-1 file's plain values may be truncated; a version-2 file's
  // plain values are full — only entries never re-committed since the
  // upgrade carry an explicit legacy flag
  const legacyFile = !(isObject(snapshot) && snapshot.version === 2);
  if (isObject(snapshot) && isObject(snapshot.titles)) {
    for (const [sid, entry] of Object.entries(snapshot.titles)) {
      const title = isNonEmptyString(entry)
        ? entry
        : isObject(entry) && isNonEmptyString(entry.title)
          ? entry.title
          : null;
      if (title === null) continue;
      titleSent.set(sid, title);
      if (legacyFile || (isObject(entry) && entry.legacy === true)) {
        legacyGate.add(sid);
      }
    }
  }
} catch {
  // missing or corrupt sidecar — start with an empty gate
}
const persistTitles = (): void => {
  try {
    atomicWriteJson(titlesFile, {
      version: 2,
      titles: Object.fromEntries(
        [...titleSent].map(([sid, title]) => [
          sid,
          legacyGate.has(sid) ? { title, legacy: true } : title,
        ]),
      ),
    });
  } catch {
    // persistence is an optimization — capture proceeds without it
  }
};
/** Sessions with a title meta in the batch — the gate-commit candidates. */
const titleSessions = (batch: NormalEvent[]): Set<string> => {
  const sessions = new Set<string>();
  for (const event of batch) {
    if (event.kind === "session" && event.event === "meta" && event.title) {
      sessions.add(event.session_id);
    }
  }
  return sessions;
};

/**
 * The first record of a rollout file — all the claim decision gets. ZCode
 * appends a record only once its request completed, but a file caught
 * mid-write can end without a newline: null means "not yet decidable" and
 * the poll simply retries.
 */
const firstRecord = (file: string): Record<string, unknown> | null => {
  let fd: number;
  try {
    fd = openSync(file, "r");
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

// ZCode rollout records carry everything worth capturing: title/task preview,
// the first record of each turn, the model-request/tool-call stream, and the
// results of earlier tool calls (echoed in the next request's messages).
const seenTurns = new Set<string>();
const seenToolResults = new Set<string>();
const seenAttachments = new Set<string>();
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
    if (isObject(record)) {
      if (sessionId === primarySessionId && isNonEmptyString(record.turnId)) {
        // the parent turn a newly discovered subagent was spawned by
        spawnedByTurnId = record.turnId;
      }
    }
    const events: NormalEvent[] = [];
    // the gate compares full titles (a retitle past the 200-char event cap
    // still ships); pending titles suppress same-batch duplicates only
    const rawTitle = titleTextFromRecord(record);
    const sent = titleSent.get(sessionId);
    let meta: SessionMetaEvent | null = null;
    if (
      rawTitle !== null &&
      rawTitle !== sent &&
      rawTitle !== pendingTitle.get(sessionId)
    ) {
      if (legacyGate.has(sessionId) && rawTitle.slice(0, 200) === sent) {
        // the legacy (version-1) gate holds the event's truncated form — this
        // rewrite is byte-identical on the wire, so nothing ships, but the
        // full title is adopted as the gate (persisted on the spot) and the
        // lossy legacy comparison retires
        titleSent.set(sessionId, rawTitle);
        legacyGate.delete(sessionId);
        persistTitles();
      } else {
        meta = metaFromRecord(record, sessionId);
      }
    }
    if (meta) {
      events.push(meta);
      pendingTitle.set(sessionId, rawTitle!);
    }
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
      seen: seenAttachments,
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
    // Child sessions get no session_title record of their own — announce
    // the subagent's task as the title (the ↳ marks the row as a subagent
    // in the sessions list). The announced title rides the same pending/
    // acked gate, so it is respawn-safe: once delivered, the persisted gate
    // suppresses the re-announce; until then, a failed batch re-announces.
    if (
      sessionId !== primarySessionId &&
      !titleSent.has(sessionId) &&
      !pendingTitle.has(sessionId)
    ) {
      const childTurnStart = events.find(
        (e): e is TurnStartEvent & { user_message: string } =>
          e.kind === "turn" &&
          e.event === "start" &&
          typeof e.user_message === "string",
      );
      if (childTurnStart) {
        pendingTitle.set(sessionId, `↳ ${childTurnStart.user_message}`);
        events.push({
          ...envelope("zcode", sessionId, childTurnStart.occurred_at),
          kind: "session",
          event: "meta",
          title: `↳ ${childTurnStart.user_message.slice(0, 119)}`,
        });
      }
    }
    return events;
  },
  onFlushed: (batch: NormalEvent[]): void => {
    // the delivery ack — the only place the title gate commits
    let committed = false;
    for (const sid of titleSessions(batch)) {
      const title = pendingTitle.get(sid);
      if (title === undefined) continue;
      titleSent.set(sid, title);
      legacyGate.delete(sid); // the committed gate is a full title
      pendingTitle.delete(sid);
      committed = true;
    }
    if (committed) persistTitles();
  },
  onFlushFailed: (batch: NormalEvent[]): void => {
    // the batch died before delivery — release the pending gates so the
    // cursor-rewound retry re-emits these titles instead of losing them
    for (const sid of titleSessions(batch)) pendingTitle.delete(sid);
  },
};

const childTails = {
  discover: (): ChildTail[] => {
    if (parentTraceId === null) {
      // The main file's first record carries the session trace even when the
      // primary tail has nothing new to drain (a respawned listener with an
      // advanced cursor) — without this, a respawn could never claim the
      // subagent files written while it was dead.
      const first = firstRecord(file);
      if (first && isNonEmptyString(first.traceId)) {
        parentTraceId = first.traceId;
      }
    }
    if (parentTraceId === null) return []; // main file not written yet
    let names: string[];
    try {
      names = readdirSync(ROLLOUT_DIR);
    } catch {
      return [];
    }
    const tails: ChildTail[] = [];
    for (const name of names) {
      const match = name.match(SUBAGENT_FILE);
      if (!match || claimedFiles.has(name)) continue;
      const file = join(ROLLOUT_DIR, name);
      const childId = match[1]!;
      const first = firstRecord(file);
      if (
        !first ||
        !isNonEmptyString(first.traceId) ||
        first.traceId !== parentTraceId
      ) {
        continue; // foreign session's subagent, or first line still mid-write
      }
      claimedFiles.add(name);
      const childStartedAt = isNonEmptyString(first.startedAt)
        ? first.startedAt
        : new Date().toISOString();
      tails.push({
        file,
        sessionId: childId,
        onStart: (): NormalEvent[] => [
          {
            ...envelope("zcode", childId, childStartedAt),
            kind: "session",
            event: "start",
            cwd: arg("cwd") ?? process.cwd(),
            hostname: hostname(),
            ...(gitRemote ? { git_remote: gitRemote } : {}),
            parent_session_id: primarySessionId,
            ...(spawnedByTurnId ? { spawned_by_turn_id: spawnedByTurnId } : {}),
          } satisfies SessionStartEvent,
        ],
        onEnd: (reason): NormalEvent[] => [
          {
            ...envelope("zcode", childId, new Date().toISOString()),
            kind: "session",
            event: "end",
            reason,
          } satisfies SessionEndEvent,
        ],
        // child turns must not close the parent turn being digested — only
        // their requests/tools fold into it
        digestTransform: (events) =>
          events.filter((e) => !(e.kind === "turn" && e.event === "start")),
      });
    }
    return tails;
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
  childTails,
  heartbeat: true,
  // ZCode's end is usually the idle/max-lifetime exit with the server maybe
  // gone — probe first so tokens are not burned on a summary that cannot ship
  probeBeforeFold: true,
  drainScript: fileURLToPath(new URL("./drain.ts", import.meta.url)),
});
