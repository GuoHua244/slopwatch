/**
 * The Codex RecordAdapter: wraps the normalizer with the per-session state
 * the tail loop drives — one TailState per tailed rollout (the session's own
 * plus each discovered subagent child), persisted to a sidecar file so a
 * respawned listener keeps turn attribution and the dedup sets (the cursor
 * resumes mid-file; fresh state would strip every model_request of its
 * turn_id until the next prompt).
 *
 * Codex rollout files never carry a session title (thread names live in the
 * global session_index.jsonl, not the rollout), so the only session:meta is
 * the task preview; child sessions get the `↳ <task>` announce, gated on the
 * flush ack exactly like the other listeners.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  envelope,
  type NormalEvent,
  type SessionEndEvent,
  type SessionStartEvent,
  type TurnStartEvent,
} from "@slopwatch/events";
import type { RecordAdapter } from "@slopwatch/listener-shared";
import { atomicWriteJson } from "@slopwatch/listener-shared";
import {
  driftFromRecord,
  eventsFromRecord,
  flushOpenResponse,
  newTailState,
  restoreTailState,
  serializeTailState,
  type TailState,
} from "./normalizer";

const TAILSTATE_SUFFIX = ".tailstate.json";

/** Sessions with a child title meta in the batch — the gate-commit candidates. */
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
  join(stateDir, `codex-${sessionId}${TAILSTATE_SUFFIX}`);

export type CodexAdapter = {
  adapter: RecordAdapter;
  /** The primary session's turn id, restored or as advanced by turn starts. */
  primaryTurnId: () => string | null;
};

export const createCodexAdapter = (opts: {
  primarySessionId: string;
  /** Defaults to the shared listener state dir. */
  stateDir?: string;
}): CodexAdapter => {
  const stateDir = opts.stateDir ?? join(homedir(), ".slopwatch", "listeners");
  const states = new Map<string, TailState>();
  // Child titles emitted into a batch the flush has not acked yet —
  // suppresses same-batch duplicates without persisting the gate first
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
      const state = stateOf(sessionId);
      const events = eventsFromRecord(record, sessionId, state);

      if (
        sessionId !== opts.primarySessionId &&
        state.titleSent === null &&
        !pendingTitle.has(sessionId)
      ) {
        // child sessions get no title record of their own — announce the
        // subagent's task as the title (↳ marks the row as a subagent).
        // The announced title rides the pending/acked gate, so it is
        // respawn-safe: once delivered, the persisted gate suppresses the
        // re-announce; until then, a failed batch re-announces on retry.
        const childTurnStart = events.find(
          (e): e is TurnStartEvent => e.kind === "turn" && e.event === "start",
        );
        if (childTurnStart) {
          const message =
            typeof childTurnStart.user_message === "string"
              ? childTurnStart.user_message
              : "(no user message text)";
          pendingTitle.set(sessionId, `↳ ${message}`);
          events.push({
            ...envelope("codex", sessionId, childTurnStart.occurred_at),
            kind: "session",
            event: "meta",
            title: `↳ ${message.slice(0, 119)}`,
          });
        }
      }
      // state-mutating records must survive a respawn — persist eagerly (a
      // bookkeeping record storm without state changes stays cheap)
      const type = (record as { type?: unknown } | null)?.type;
      if (typeof type === "string" && type !== "world_state") {
        persist(sessionId, state);
      }
      return events;
    },
    onTeardown: (): NormalEvent[] => {
      const events: NormalEvent[] = [];
      for (const [sessionId, state] of states) {
        const open = flushOpenResponse(state, sessionId);
        if (open) events.push(open);
        persist(sessionId, state);
      }
      return events;
    },
    onFlushed: (batch: NormalEvent[]): void => {
      // the delivery ack — the only place the child title gate commits
      for (const sessionId of titleSessions(batch)) {
        const state = states.get(sessionId);
        const title = pendingTitle.get(sessionId);
        if (!state || title === undefined) continue;
        state.titleSent = title;
        state.titleSentLegacy = false;
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
    ...envelope("codex", input.childId, input.startedAt),
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
    ...envelope("codex", input.childId, new Date().toISOString()),
    kind: "session",
    event: "end",
    reason,
  }),
});
