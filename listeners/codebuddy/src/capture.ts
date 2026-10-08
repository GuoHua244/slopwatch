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
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import {
  envelope,
  quarantineLine,
  type NormalEvent,
  type SessionMetaEvent,
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
};

export type CaptureOptions = {
  ref: ConversationRef;
  sessionId: string;
  /** Path of the sidecar JSON the state round-trips through. */
  stateFile: string;
  /** The workspace's per-day agent log, when one was found. */
  usageLog?: string | null;
  /** Title truncation budget for the dashboard's session rail. */
  maxTitle?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Wait for token counts before shipping without them (ms). */
  usageGraceMs?: number;
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
  };
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
  // Messages already read once: a respawn re-reads its own backlog only.
  let explained = false;
  const now = opts.now ?? Date.now;

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
    if (!opts.usageLog) return;
    const tail = readTail(opts.usageLog, state.usageCursor);
    if (!tail) {
      // rotated to a fresh day-file: start it from the beginning
      state.usageCursor = 0;
      return;
    }
    if (tail.size < state.usageCursor) state.usageCursor = 0; // truncated
    if (tail.text.length === 0) {
      state.usageCursor = tail.size;
      return;
    }
    for (const [id, record] of indexUsageByMessage(
      usageFromLogText(tail.text),
    )) {
      usageByMessage.set(id, record);
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
    const deadline = opts.usageGraceMs ?? USAGE_GRACE_MS;
    const kept: string[] = [];
    for (const id of state.pending) {
      const resolved = usageByMessage.has(id);
      if (!resolved && now() - (pendingSince.get(id) ?? now()) < deadline) {
        kept.push(id);
        continue;
      }
      // resolved (counts arrived) or expired (they never will) — ship it
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

      for (const row of newIndexMessages(parsed.value, state.processed)) {
        state.processed += 1;
        const { events: evts, held } = eventsFor(row.id);
        if (held) state.pending.push(row.id);
        else events.push(...evts);
      }
      releaseExpiredPending(events);
      events.push(...titleEvent());
      // one explainer per listener generation: why the first events lag a few
      // seconds is otherwise invisible in the log the user never reads
      if (!explained && state.pending.length > 0) {
        explained = true;
        console.error(
          `capture: ${state.pending.length} model request(s) waiting for token counts (they ship without usage after ${opts.usageGraceMs ?? USAGE_GRACE_MS}ms)`,
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
