/**
 * The CodeBuddy capture engine — the agent-specific half that sits between
 * the host's files and the shared shipping kernel.
 *
 * Unlike Claude Code and ZCode, this agent's history is not a line-appended
 * log but a **manifest plus a directory of immutable per-message files**:
 * `index.json` is rewritten whole on every step and each message lands once
 * under `messages/<id>.json`. So instead of a byte cursor over lines we keep
 * a positional watermark into the manifest's `messages` array (respawn-safe:
 * rows are appended) plus the set of message ids whose model request is still
 * waiting for its token counts.
 *
 * That wait is the interesting part: usage lives in another file entirely
 * (the agent log) and lands within the same millisecond in practice, but the
 * order is not guaranteed, so a model request with no usage yet is HELD —
 * shipping first and amending later is impossible once an event is sent —
 * with a hard grace after which evidence ships without counts rather than
 * never.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import {
  envelope,
  quarantineLine,
  type ModelRequestEvent,
  type NormalEvent,
  type SessionEndEvent,
  type SessionMetaEvent,
  type SessionStartEvent,
} from "@slopwatch/events";
import { atomicWriteJson } from "@slopwatch/listener-shared";
import {
  conversationIndexPath,
  messagePath,
  workspaceIndexPath,
  type ConversationRef,
} from "./paths";
import {
  AGENT,
  newTailState,
  normalizeMessage,
  PROVIDER,
  trimTailState,
  type TailState,
} from "./normalizer";
import {
  conversationTitle,
  newIndexMessages,
  parseConversationIndex,
  parseMessageFile,
  parseWorkspaceIndex,
} from "./transcript";
import {
  USAGE_GRACE_MS,
  indexUsageByMessage,
  usageFromLogText,
  type UsageRecord,
} from "./usage";
import {
  CHILD_IDLE_MS,
  childSessionId,
  modelByPrefix,
  parseAgentRuns,
  type AgentRun,
} from "./subagent";

/** One sub-agent run, as far as this listener has shipped it. */
export type ChildState = {
  agentType: string;
  model: string | null;
  startedAt: string;
  /** Steps of this run already shipped. */
  emitted: number;
  ended: boolean;
  /** Epoch ms of the newest step seen — the idle clock for this run. */
  lastSeenMs: number;
};

/**
 * Persisted across listener generations: a respawn must neither re-emit the
 * conversation nor forget which turn the next model request belongs to.
 */
export type CaptureState = TailState & {
  /** Rows of the manifest already drained. */
  processed: number;
  /** Bytes of the usage log already drained. */
  usageCursor: number;
  /** Message ids whose model request is still waiting for its counts. */
  pending: string[];
  /** The title already delivered — suppression is only committed on ack. */
  titleSent: string | null;
  /**
   * Request ids seen on the parent's own messages. Anything else in the log
   * is a sub-agent run, not this session's step.
   */
  parentRuns: string[];
  /** Sub-agent runs, keyed by run id. */
  children: Record<string, ChildState>;
};

export type CaptureOptions = {
  ref: ConversationRef;
  sessionId: string;
  /** Path of the sidecar JSON the state round-trips through. */
  stateFile: string;
  /** The workspace's per-day agent log, when one was found. */
  usageLog?: string | null;
  /**
   * Re-resolve the usage log on demand: the day directory is created by the
   * logger's first flush, which can lag the session's first hook by minutes,
   * and midnight rotates the path. Null while there is still nothing.
   */
  resolveUsageLog?: () => string | null;
  /** Title truncation budget for the dashboard's session rail. */
  maxTitle?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Wait for token counts before shipping without them (ms). */
  usageGraceMs?: number;
  /** Environment facts for child sessions (the parent's are live.ts's job). */
  cwd?: string;
  hostname?: string;
};

export type CodebuddyCapture = {
  /** Drain whatever is new since the last poll. Never throws. */
  poll(): NormalEvent[];
  /** Everything still held back — shipped before the session's end event. */
  teardown(): NormalEvent[];
  /** Delivery ack: commit the gates suppressed until now. */
  onFlushed(batch: NormalEvent[]): void;
  /** Release the gates of a batch that never shipped. */
  onFlushFailed(batch: NormalEvent[]): void;
};

const newState = (): CaptureState => ({
  ...newTailState(),
  processed: 0,
  usageCursor: 0,
  pending: [],
  titleSent: null,
  parentRuns: [],
  children: {},
});

const restoreState = (raw: unknown): CaptureState | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  return {
    turnId: typeof row.turnId === "string" ? row.turnId : null,
    emittedToolResults: Array.isArray(row.emittedToolResults)
      ? row.emittedToolResults.filter((v): v is string => typeof v === "string")
      : [],
    processed:
      typeof row.processed === "number" && row.processed >= 0
        ? Math.trunc(row.processed)
        : 0,
    usageCursor:
      typeof row.usageCursor === "number" && row.usageCursor >= 0
        ? Math.trunc(row.usageCursor)
        : 0,
    pending: Array.isArray(row.pending)
      ? row.pending.filter((v): v is string => typeof v === "string")
      : [],
    titleSent: typeof row.titleSent === "string" ? row.titleSent : null,
    parentRuns: Array.isArray(row.parentRuns)
      ? row.parentRuns.filter((v): v is string => typeof v === "string")
      : [],
    children: restoreChildren(row.children),
  };
};

const restoreChildren = (raw: unknown): Record<string, ChildState> => {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, ChildState> = {};
  for (const [runId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const row = value as Record<string, unknown>;
    if (typeof row.agentType !== "string") continue;
    out[runId] = {
      agentType: row.agentType,
      model: typeof row.model === "string" ? row.model : null,
      startedAt: typeof row.startedAt === "string" ? row.startedAt : "",
      emitted:
        typeof row.emitted === "number" && row.emitted >= 0
          ? Math.trunc(row.emitted)
          : 0,
      ended: row.ended === true,
      lastSeenMs:
        typeof row.lastSeenMs === "number" && Number.isFinite(row.lastSeenMs)
          ? row.lastSeenMs
          : 0,
    };
  }
  return out;
};

const readTail = (
  path: string,
  cursor: number,
): { text: string; size: number } | null => {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null; // not written yet / rotated away
  }
  if (size <= cursor) return { text: "", size };
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(size - cursor);
  readSync(fd, buf, 0, buf.length, cursor);
  closeSync(fd);
  return { text: buf.toString("utf8"), size };
};

/** Absolute ceiling for a held request, quiet log or not. */
const PENDING_MAX_MS = 15 * 60_000;

export const createCodebuddyCapture = (
  opts: CaptureOptions,
): CodebuddyCapture => {
  let state: CaptureState = (() => {
    try {
      return (
        restoreState(JSON.parse(readFileSync(opts.stateFile, "utf8"))) ??
        newState()
      );
    } catch {
      return newState(); // missing or corrupt sidecar — capture starts over
    }
  })();

  const usageByMessage = new Map<string, UsageRecord>();
  const pendingSince = new Map<string, number>();
  /** Re-resolved when null — the log's day directory may not exist yet. */
  let usageLog = opts.usageLog ?? null;
  // Sub-agent accounting: steps grouped by their run id, and the agent type
  // that started each run. Nothing here is read from the conversation — a
  // sub-agent writes no messages into it.
  const usageByRun = new Map<string, UsageRecord[]>();
  const runTypes = new Map<string, AgentRun>();
  const modelByAgentType = new Map<string, string>();
  const parentRunIds = new Set<string>(state.parentRuns);
  /** Ids of every row the manifest has ever shown (parent-owned steps). */
  const manifestIds = new Set<string>();
  // Messages already read once: a respawn re-reads its own backlog only.
  let explained = false;
  const now = opts.now ?? Date.now;
  /** Last poll that saw new log bytes — the logger flushes in bursts. */
  let usageProgressAt = now();
  /**
   * The host logger flushes in delayed bursts (measured 40–95s behind the
   * line's own timestamp), so counts routinely land well after the message
   * they belong to. A held request gives up only once the log has been quiet
   * this long — new bytes mean the counts may still be inbound.
   */
  const quietMs = (opts.usageGraceMs ?? USAGE_GRACE_MS) * 2;
  /** The conversation's own start, from its first message — set lazily. */
  let conversationStartMs: number | null = null;

  const persist = (): void => {
    try {
      atomicWriteJson(opts.stateFile, trimTailState(state));
    } catch {
      // persistence is an optimization — capture proceeds without it
    }
  };

  const readMaybe = (path: string): string | null => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };

  const drainUsage = (): void => {
    if (!usageLog && opts.resolveUsageLog) usageLog = opts.resolveUsageLog();
    if (!usageLog) return;
    const tail = readTail(usageLog, state.usageCursor);
    if (!tail) {
      // rotated away (midnight): re-resolve and read the replacement from
      // the beginning
      const next = opts.resolveUsageLog?.() ?? null;
      if (next && next !== usageLog) {
        usageLog = next;
        state.usageCursor = 0;
      }
      return;
    }
    if (tail.size < state.usageCursor) state.usageCursor = 0; // truncated
    if (tail.text.length === 0) {
      state.usageCursor = tail.size;
      return;
    }
    usageProgressAt = now(); // new bytes — counts may still be inbound
    const drained = usageFromLogText(tail.text);
    for (const [id, record] of indexUsageByMessage(drained)) {
      usageByMessage.set(id, record);
    }
    for (const run of parseAgentRuns(tail.text)) runTypes.set(run.runId, run);
    for (const [type, model] of modelByPrefix(tail.text))
      modelByAgentType.set(type, model);
    // A step belongs to this session when its run id (or its message) is the
    // parent's; everything else in this workspace's log is a sub-agent run.
    for (const record of drained) {
      if (!record.requestId) continue;
      if (parentRunIds.has(record.requestId)) continue;
      if (record.messageId !== null && manifestIds.has(record.messageId))
        continue;
      const steps = usageByRun.get(record.requestId) ?? [];
      steps.push(record);
      usageByRun.set(record.requestId, steps);
    }
    state.usageCursor = tail.size;
  };

  const eventsFor = (
    messageId: string,
    /**
     * Emit even without token counts — set once the grace window has passed
     * or the listener is tearing down; evidence must never be lost to a
     * missing number.
     */
    force = false,
  ): { events: NormalEvent[]; held: boolean } => {
    const raw = readMaybe(messagePath(opts.ref, messageId));
    if (raw === null) return { events: [], held: false };
    const parsed = parseMessageFile(raw);
    if (!parsed.ok) {
      return {
        events: [
          quarantineLine({
            agent: AGENT,
            session_id: opts.sessionId,
            reason: parsed.reason,
            line: raw.slice(0, 4_096),
          }),
        ],
        held: false,
      };
    }
    const usage = usageByMessage.get(messageId) ?? null;
    const holdUntilUsage =
      parsed.message.role === "assistant" && usage === null && !force;
    if (holdUntilUsage) {
      pendingSince.set(messageId, pendingSince.get(messageId) ?? now());
      return { events: [], held: true };
    }
    pendingSince.delete(messageId);
    // the parent's own run id: how the log's sub-agent runs are told apart
    if (
      parsed.message.requestId &&
      !parentRunIds.has(parsed.message.requestId)
    ) {
      parentRunIds.add(parsed.message.requestId);
      state.parentRuns.push(parsed.message.requestId);
      // retro-active: a step drained before its message was read is the
      // parent's, so drop any child run started with this id
      usageByRun.delete(parsed.message.requestId);
    }
    return {
      events: normalizeMessage({
        message: parsed.message,
        sessionId: opts.sessionId,
        state,
        usage,
      }),
      held: false,
    };
  };

  const pendingTitle = { value: null as string | null };

  const titleEvent = (): SessionMetaEvent[] => {
    if (pendingTitle.value !== null) return [];
    const indexText = readMaybe(workspaceIndexPath(opts.ref));
    if (indexText === null) return [];
    const title = conversationTitle(
      parseWorkspaceIndex(indexText),
      opts.ref.conversationId,
    );
    if (!title) return [];
    const cut = title.slice(0, opts.maxTitle ?? 200);
    if (state.titleSent === cut) return [];
    pendingTitle.value = cut;
    return [metaEvent(opts.sessionId, cut)];
  };

  const releaseExpiredPending = (events: NormalEvent[]): void => {
    if (state.pending.length === 0) return;
    const kept: string[] = [];
    for (const id of state.pending) {
      const resolved = usageByMessage.has(id);
      if (!resolved) {
        const age = now() - (pendingSince.get(id) ?? now());
        const quietFor = now() - usageProgressAt;
        // counts that flush late are the norm, not the exception — while the
        // usage log is still growing they may land any tick, so only a log
        // that has gone quiet (or the absolute ceiling) ships without them
        if (age < PENDING_MAX_MS && quietFor < quietMs) {
          kept.push(id);
          continue;
        }
      }
      // resolved (counts arrived) or given up on — ship it
      const { events: evts } = eventsFor(id, true);
      events.push(...evts);
    }
    state.pending = kept;
  };

  const release = (): NormalEvent[] => {
    const events: NormalEvent[] = [];
    for (const id of state.pending) {
      const { events: evts } = eventsFor(id, true);
      events.push(...evts);
    }
    state.pending = [];
    // the host logs no end for a sub-agent run, so this listener closes them
    events.push(...endChildren("listener-end"));
    return events;
  };

  /**
   * The agent type of the session's own run — known once a message of ours
   * has been read. Until then a stray step cannot be told from a sub-agent
   * one, so children wait rather than risk inventing a session.
   */
  const parentType = (): string | null => {
    for (const runId of parentRunIds) {
      const type = runTypes.get(runId)?.agentType;
      if (type) return type;
    }
    return null;
  };

  const childStartEvent = (run: AgentRun): SessionStartEvent => ({
    ...envelope(AGENT, childSessionId(run.runId), run.startedAt),
    kind: "session",
    event: "start",
    cwd: opts.cwd ?? "",
    hostname: opts.hostname ?? "",
    parent_session_id: opts.sessionId,
    ...(state.turnId ? { spawned_by_turn_id: state.turnId } : {}),
  });

  const childRequestEvent = (
    runId: string,
    model: string,
    record: UsageRecord,
  ): ModelRequestEvent => ({
    ...envelope(AGENT, childSessionId(runId), record.occurredAt),
    kind: "model_request",
    provider: PROVIDER,
    model,
    duration_ms: record.durationMs ?? 0,
    ...(record.requestId ? { request_id: record.requestId } : {}),
    usage: record.usage,
  });

  const childEndEvent = (runId: string, reason: string): SessionEndEvent => ({
    ...envelope(AGENT, childSessionId(runId), new Date(now()).toISOString()),
    kind: "session",
    event: "end",
    reason,
  });

  const shipChildren = (events: NormalEvent[]): void => {
    const mine = parentType();
    if (mine === null) return;
    for (const [runId, steps] of usageByRun) {
      const run = runTypes.get(runId);
      // a run we never saw start cannot be attributed — skip rather than
      // invent an agent type for it
      if (!run || run.agentType === mine) continue;
      const known = state.children[runId];
      const child: ChildState = known ?? {
        agentType: run.agentType,
        model: modelByAgentType.get(run.agentType) ?? null,
        startedAt: run.startedAt,
        emitted: 0,
        ended: false,
        lastSeenMs: now(),
      };
      if (!known) {
        state.children[runId] = child;
        events.push(childStartEvent(run));
        // the ↳ marker is how the sessions list shows this is a sub-agent
        events.push(metaEvent(childSessionId(runId), `↳ ${run.agentType}`));
      }
      for (const record of steps.slice(child.emitted)) {
        events.push(childRequestEvent(runId, child.model ?? "unknown", record));
        child.emitted += 1;
        child.lastSeenMs = Math.max(
          child.lastSeenMs,
          Date.parse(record.occurredAt) || child.lastSeenMs,
        );
      }
      if (!child.ended && now() - child.lastSeenMs > CHILD_IDLE_MS) {
        child.ended = true;
        events.push(childEndEvent(runId, "idle-timeout"));
      }
    }
  };

  const endChildren = (reason: string): NormalEvent[] => {
    const events: NormalEvent[] = [];
    for (const [runId, child] of Object.entries(state.children)) {
      if (child.ended) continue;
      child.ended = true;
      events.push(childEndEvent(runId, reason));
    }
    return events;
  };

  const poll = (): NormalEvent[] => {
    const events: NormalEvent[] = [];
    try {
      drainUsage();
      const indexText = readMaybe(conversationIndexPath(opts.ref));
      if (indexText === null) return events;
      const parsed = parseConversationIndex(indexText);
      if (!parsed.ok) {
        events.push(
          quarantineLine({
            agent: AGENT,
            session_id: opts.sessionId,
            reason: parsed.reason,
            line: indexText.slice(0, 4_096),
          }),
        );
        return events;
      }
      // a conversation rewrite that dropped rows (index rebuilt) simply means
      // fewer rows than our watermark — resume from the tail we can see
      if (parsed.value.messages.length < state.processed)
        state.processed = parsed.value.messages.length;

      for (const row of parsed.value.messages) manifestIds.add(row.id);
      // the workspace log outlives the conversation and is replayed from byte
      // 0 on attach — runs whose first step predates the conversation itself
      // belong to an earlier conversation and must not be adopted as children
      if (conversationStartMs === null && parsed.value.messages.length > 0) {
        const raw = readMaybe(
          messagePath(opts.ref, parsed.value.messages[0]!.id),
        );
        const first = raw === null ? null : parseMessageFile(raw);
        if (first?.ok) {
          const t = Date.parse(first.message.createdAt);
          if (Number.isFinite(t)) conversationStartMs = t;
        }
      }
      if (conversationStartMs !== null) {
        for (const [runId, steps] of usageByRun) {
          const firstStep = Date.parse(steps[0]?.occurredAt ?? "");
          if (Number.isFinite(firstStep) && firstStep < conversationStartMs)
            usageByRun.delete(runId);
        }
      }
      for (const row of newIndexMessages(parsed.value, state.processed)) {
        // an index row can lead its message file by a beat — one poll landing
        // in that gap consumed a whole conversation's steps as read failures.
        // rows are appended in order, so wait for the file and retry next tick
        if (!existsSync(messagePath(opts.ref, row.id))) break;
        state.processed += 1;
        const { events: evts, held } = eventsFor(row.id);
        if (held) state.pending.push(row.id);
        else events.push(...evts);
      }
      releaseExpiredPending(events);
      shipChildren(events);
      events.push(...titleEvent());
      // one explainer per listener generation: why the first events lag a few
      // seconds is otherwise invisible in the log the user never reads
      if (!explained && state.pending.length > 0) {
        explained = true;
        console.error(
          `capture: ${state.pending.length} model request(s) waiting for token counts (they ship without usage after ${quietMs}ms of usage-log silence)`,
        );
      }
      persist();
    } catch (e) {
      console.error(
        `capture: poll failed (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    return events;
  };

  return {
    poll,
    teardown: release,
    onFlushed: (batch) => {
      for (const event of batch) {
        if (event.kind === "session" && event.event === "meta" && event.title) {
          // the delivery ack — the only place the title gate commits
          state.titleSent = event.title;
          if (pendingTitle.value === event.title) pendingTitle.value = null;
        }
      }
      persist();
    },
    onFlushFailed: (batch) => {
      for (const event of batch) {
        if (event.kind === "session" && event.event === "meta" && event.title) {
          // the batch died before delivery — re-announce the title on retry
          if (pendingTitle.value === event.title) pendingTitle.value = null;
        }
      }
    },
  };
};

const metaEvent = (sessionId: string, title: string): SessionMetaEvent => ({
  ...envelope(AGENT, sessionId, new Date().toISOString()),
  kind: "session",
  event: "meta",
  title,
});
