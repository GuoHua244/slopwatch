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
import { existsSync, readFileSync, rmSync } from "node:fs";
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
  flushOpenMessage,
  metaFromRecord,
  newTailState,
  restoreTailState,
  serializeTailState,
  type CaptureSink,
  type TailState,
} from "./normalizer";

const TAILSTATE_SUFFIX = ".tailstate.json";

const tailStateFile = (stateDir: string, sessionId: string): string =>
  join(stateDir, `claude-code-${sessionId}${TAILSTATE_SUFFIX}`);

export type ClaudeCodeAdapter = {
  adapter: RecordAdapter;
  /** The primary session's turn id, restored or as advanced by turn starts. */
  primaryTurnId: () => string | null;
  /** Drop a session's state (memory + sidecar) — child tails call this on end. */
  forgetSession: (sessionId: string) => void;
  /** Flush the primary session's open message, if any (replay/backfill). */
  flushPrimary: () => NormalEvent[];
};

export const createClaudeCodeAdapter = (opts: {
  primarySessionId: string;
  /** Defaults to the shared listener state dir. */
  stateDir?: string;
}): ClaudeCodeAdapter => {
  const stateDir = opts.stateDir ?? join(homedir(), ".slopwatch", "listeners");
  const states = new Map<string, TailState>();
  const seenShas = new Set<string>(); // attachment dedup, per listener run
  const childTitleSent = new Set<string>();

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
      // few minutes — identical titles are suppressed, real retitles ship
      const candidate = metaFromRecord(record, sessionId);
      const meta = candidate?.title === state.titleSent ? null : candidate;
      // metaFromRecord only produces title metas — the guard narrows the
      // optional `title` so the persisted gate stays a string
      if (meta?.title !== undefined) state.titleSent = meta.title;
      const events = eventsFromRecord(record, sessionId, state, {
        seen: seenShas,
      });
      const all = meta ? [meta, ...events] : events;

      if (!isPrimary && !childTitleSent.has(sessionId)) {
        // child sessions get no title record of their own — announce the
        // subagent's task as the title (↳ marks the row as a subagent)
        const childTurnStart = all.find(
          (e): e is TurnStartEvent => e.kind === "turn" && e.event === "start",
        );
        if (childTurnStart) {
          childTitleSent.add(sessionId);
          const message =
            typeof childTurnStart.user_message === "string"
              ? childTurnStart.user_message
              : "(no user message text)";
          all.push({
            ...envelope("claude-code", sessionId, childTurnStart.occurred_at),
            kind: "session",
            event: "meta",
            title: `↳ ${message.slice(0, 119)}`,
          });
        }
      }
      // user/assistant records mutate the tail state; title records mutate
      // the shipped-title gate — both must survive a respawn
      const type = (record as { type?: unknown } | null)?.type;
      if (type === "user" || type === "assistant" || meta) {
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
    forgetSession: (sessionId: string): void => {
      states.delete(sessionId);
      // best effort — a lingering sidecar for a dead child is harmless
      try {
        rmSync(tailStateFile(stateDir, sessionId), { force: true });
      } catch {
        // already gone
      }
    },
    flushPrimary: (): NormalEvent[] => {
      const state = stateOf(opts.primarySessionId);
      const flushed = flushOpenMessage(state, opts.primarySessionId);
      return flushed ? [flushed] : [];
    },
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
