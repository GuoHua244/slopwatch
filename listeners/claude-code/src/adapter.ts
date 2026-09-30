/**
 * The Claude Code RecordAdapter: wraps the normalizer with the per-session
 * state the tail loop drives — one TailState per tailed transcript (the
 * session's own plus each discovered subagent child), persisted to a sidecar
 * file so a respawned listener keeps turn attribution and the dedup sets
 * (the cursor resumes mid-transcript; fresh state would strip every
 * model_request of its turn_id until the next prompt).
 *
 * Sidechain guard: subagent traffic carries `isSidechain: true`. On old
 * builds it rides the primary transcript inline — it belongs to the child
 * session (captured from `subagents/agent-*.jsonl`), never to the parent's
 * turns. Child tails normalize the same records with the guard off.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  envelope,
  type NormalEvent,
  type SessionEndEvent,
  type SessionMetaEvent,
  type SessionStartEvent,
  type TurnStartEvent,
} from "@slopwatch/events";
import type { RecordAdapter } from "@slopwatch/listener-shared";
import { atomicWriteJson } from "@slopwatch/listener-shared";
import {
  driftFromRecord,
  eventsFromRecord,
  flushOpenMessage,
  metaFromRecord,
  newTailState,
  restoreTailState,
  serializeTailState,
  titleFromRecord,
  type CaptureSink,
  type TailState,
} from "./normalizer";

const TAILSTATE_SUFFIX = ".tailstate.json";

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

const tailStateFile = (stateDir: string, sessionId: string): string =>
  join(stateDir, `claude-code-${sessionId}${TAILSTATE_SUFFIX}`);

export type ClaudeCodeAdapter = {
  adapter: RecordAdapter;
  /** The primary session's turn id, restored or as advanced by turn starts. */
  primaryTurnId: () => string | null;
};

export const createClaudeCodeAdapter = (opts: {
  primarySessionId: string;
  /** Defaults to the shared listener state dir. */
  stateDir?: string;
}): ClaudeCodeAdapter => {
  const stateDir = opts.stateDir ?? join(homedir(), ".slopwatch", "listeners");
  const states = new Map<string, TailState>();
  const seenShas = new Set<string>(); // attachment dedup, per listener run
  // Titles emitted into a batch the flush has not acked yet — suppresses
  // same-batch duplicates without persisting the gate before delivery
  const pendingTitle = new Map<string, string>();

  const stateOf = (sessionId: string): TailState => {
    const existing = states.get(sessionId);
    if (existing) return existing;
    const file = tailStateFile(stateDir, sessionId);
    let state: TailState | null = null;
    if (existsSync(file)) {
      try {
        state = restoreTailState(JSON.parse(readFileSync(file, "utf8")));
      } catch {
        state = null; // corrupt sidecar — fresh state, capture continues
      }
    }
    const fresh = state ?? newTailState();
    states.set(sessionId, fresh);
    return fresh;
  };

  const persist = (sessionId: string, state: TailState): void => {
    try {
      atomicWriteJson(
        tailStateFile(stateDir, sessionId),
        serializeTailState(state),
      );
    } catch {
      // persistence is an optimization — capture proceeds without it
    }
  };

  const adapter: RecordAdapter = {
    driftFromRecord,
    eventsFromRecord: (record: unknown, sessionId: string): NormalEvent[] => {
      if (!isSubagentSession(sessionId) && isSidechainRecord(record)) {
        // inline subagent traffic on the primary transcript — the child
        // tail owns it; normalizing it here would forge parent turns
        return [];
      }
      const state = stateOf(sessionId);
      const isPrimary = sessionId === opts.primarySessionId;
      // Claude Code rewrites the (usually unchanged) ai-title record every
      // few minutes — identical titles are suppressed, real retitles ship.
      // The gate compares full titles and commits only on the flush ack
      // (see onFlushed); a batch that never shipped must not gate its retry.
      const rawTitle = titleFromRecord(record);
      const sent = state.titleSent;
      let meta: SessionMetaEvent | null = null;
      if (
        rawTitle !== null &&
        rawTitle !== sent &&
        rawTitle !== pendingTitle.get(sessionId)
      ) {
        if (state.titleSentLegacy && rawTitle.slice(0, 200) === sent) {
          // a version-1 sidecar stored the event's truncated form — this
          // rewrite is byte-identical on the wire, so nothing ships, but the
          // full title is adopted as the gate (persisted on the spot) and
          // the lossy legacy comparison retires
          state.titleSent = rawTitle;
          state.titleSentLegacy = false;
          persist(sessionId, state);
        } else {
          meta = metaFromRecord(record, sessionId);
        }
      }
      if (meta) pendingTitle.set(sessionId, rawTitle!);
      const events = eventsFromRecord(record, sessionId, state, {
        seen: seenShas,
      });
      const all = meta ? [meta, ...events] : events;

      if (
        !isPrimary &&
        state.titleSent === null &&
        !pendingTitle.has(sessionId)
      ) {
        // child sessions get no title record of their own — announce the
        // subagent's task as the title (↳ marks the row as a subagent).
        // The announced title rides the same pending/acked gate, so it is
        // respawn-safe: once delivered, the persisted gate suppresses the
        // re-announce; until then, a failed batch re-announces on retry.
        const childTurnStart = all.find(
          (e): e is TurnStartEvent => e.kind === "turn" && e.event === "start",
        );
        if (childTurnStart) {
          const message =
            typeof childTurnStart.user_message === "string"
              ? childTurnStart.user_message
              : "(no user message text)";
          pendingTitle.set(sessionId, `↳ ${message}`);
          all.push({
            ...envelope("claude-code", sessionId, childTurnStart.occurred_at),
            kind: "session",
            event: "meta",
            title: `↳ ${message.slice(0, 119)}`,
          });
        }
      }
      // user/assistant records mutate the tail state and must survive a
      // respawn; title gating commits separately on the flush ack
      const type = (record as { type?: unknown } | null)?.type;
      if (type === "user" || type === "assistant") {
        persist(sessionId, state);
      }
      return all;
    },
    onTeardown: (): NormalEvent[] => {
      const events: NormalEvent[] = [];
      for (const [sessionId, state] of states) {
        const flushed = flushOpenMessage(state, sessionId);
        if (flushed) events.push(flushed);
        persist(sessionId, state);
      }
      return events;
    },
    onFlushed: (batch: NormalEvent[]): void => {
      // the delivery ack — the only place the title gate commits. Sessions
      // with a title meta in the shipped batch get their pending (full)
      // title persisted; the last meta in the batch wins, matching the
      // server's last-write-wins title upsert
      for (const sessionId of titleSessions(batch)) {
        const state = states.get(sessionId);
        const title = pendingTitle.get(sessionId);
        if (!state || title === undefined) continue;
        state.titleSent = title;
        state.titleSentLegacy = false; // the committed gate is a full title
        pendingTitle.delete(sessionId);
        persist(sessionId, state);
      }
    },
    onFlushFailed: (batch: NormalEvent[]): void => {
      // the batch died before delivery — release the pending gates so the
      // cursor-rewound retry re-emits these titles instead of losing them
      for (const sessionId of titleSessions(batch)) {
        pendingTitle.delete(sessionId);
      }
    },
  };

  const isSubagentSession = (sessionId: string): boolean =>
    sessionId !== opts.primarySessionId;

  const isSidechainRecord = (record: unknown): boolean =>
    typeof record === "object" &&
    record !== null &&
    (record as { isSidechain?: unknown }).isSidechain === true;

  return {
    adapter,
    primaryTurnId: () => stateOf(opts.primarySessionId).turnId,
  };
};

/** Re-exported for replay/backfill tools that build one-shot event batches. */
export const childSessionMarkers = (input: {
  childId: string;
  parentId: string;
  spawnedByTurnId?: string;
  cwd: string;
  hostname: string;
  gitRemote?: string;
  startedAt: string;
}): { start: SessionStartEvent; end: (reason: string) => SessionEndEvent } => ({
  start: {
    ...envelope("claude-code", input.childId, input.startedAt),
    kind: "session",
    event: "start",
    cwd: input.cwd,
    hostname: input.hostname,
    ...(input.gitRemote ? { git_remote: input.gitRemote } : {}),
    parent_session_id: input.parentId,
    ...(input.spawnedByTurnId
      ? { spawned_by_turn_id: input.spawnedByTurnId }
      : {}),
  },
  end: (reason: string): SessionEndEvent => ({
    ...envelope("claude-code", input.childId, new Date().toISOString()),
    kind: "session",
    event: "end",
    reason,
  }),
});
