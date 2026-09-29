/**
 * Normalize Claude Code transcript records into NormalEvents.
 *
 * Capture surface (research/coding-agent-ingestion.md, "Claude Code"): the
 * JSONL transcript at `~/.claude/projects/<cwd-hash>/<session-uuid>.jsonl`,
 * one JSON line per message event; schema undocumented, pinned defensively —
 * unknown shapes yield no events rather than throwing.
 *
 * One model request = one assistant `message.id` (verified against real
 * machine transcripts, 2026-09-29): Claude Code appends ONE RECORD PER
 * CONTENT BLOCK — thinking, text, one per tool_use — all sharing the
 * message.id, with the full-message usage repeated identically on every
 * record, and `tool_result` user records interleaved BETWEEN a message's
 * own records (tools stream while the message is still being appended).
 * The tailer therefore aggregates per message.id:
 * - tool:call ships the moment its block record lands (interleaved results
 *   name themselves through it), and
 * - the model_request flushes when the message closes — an assistant record
 *   with a different id, a real user prompt, or teardown — carrying the last
 *   usage, the accumulated prose, and the pre-message gap as duration.
 *
 * Tool-to-turn attribution: transcript records carry no turn id, so the
 * tailer files each record under the turn opened by the latest real user
 * prompt (same positional rule the dashboard applies; see ADR 0002).
 */
import {
  envelope,
  isNonEmptyString,
  isObject,
  MAX_IMAGES_PER_REF,
  type AttachmentEvent,
  type ModelRequestEvent,
  type NormalEvent,
  type SessionMetaEvent,
  type TokenUsage,
  type ToolCallEvent,
  type ToolResultEvent,
  type TurnStartEvent,
} from "@slopwatch/events";
import { captureInlineImages, usageOf } from "./images";

/**
 * Attachment capture state handed to eventsFromRecord: the seen-sha set
 * dedupes across the listener run (re-pasted images ride once). Produced
 * attachment events ride the returned event list, ahead of the event that
 * references them.
 */
export type CaptureSink = {
  seen: Set<string>;
};

/** An assistant message whose records are still arriving. */
export type OpenMessage = {
  messageId: string;
  model: string | null;
  /**
   * The request-boundary gap captured when the group OPENED — interleaved
   * tool results keep advancing the global clock while the message streams,
   * so the duration base must be pinned here, not read at flush time.
   */
  baseTimestampMs: number | null;
  firstTimestampMs: number | null;
  lastTimestampMs: number | null;
  texts: string[];
  usage: TokenUsage | null;
  /** The newest record seen for this message — rides the flushed request. */
  rawRecord: unknown;
};

/** Cross-record tailer state; one instance per live transcript. */
export type TailState = {
  /** Turn opened by the latest real user prompt. */
  turnId: string | null;
  /**
   * Wall-clock (ms) of the most recent record that did NOT belong to the
   * open message — the request-boundary gap the next duration measures.
   */
  outsideTimestampMs: number | null;
  /** message.ids whose model_request has been flushed (streaming/re-read dupes). */
  seenMessageIds: Set<string>;
  /** tool_use block ids already emitted. */
  seenToolUseIds: Set<string>;
  /** tool_call_id → tool name, so results can name their call. */
  toolNames: Map<string, string>;
  taskPreviewSent: boolean;
  open: OpenMessage | null;
};

export const newTailState = (): TailState => ({
  turnId: null,
  outsideTimestampMs: null,
  seenMessageIds: new Set(),
  seenToolUseIds: new Set(),
  toolNames: new Map(),
  taskPreviewSent: false,
  open: null,
});

/** Caps keeping the persisted snapshot bounded (LRU by insertion order). */
const SEEN_MESSAGE_CAP = 2000;
const SEEN_TOOL_USE_CAP = 2000;
const TOOL_NAME_CAP = 500;

/** JSON shape of a persisted TailState (the per-session sidecar file). */
export type TailStateSnapshot = {
  version: 1;
  turnId: string | null;
  outsideTimestampMs: number | null;
  taskPreviewSent: boolean;
  seenMessageIds: string[];
  seenToolUseIds: string[];
  toolNames: [string, string][];
  open: {
    messageId: string;
    model: string | null;
    baseTimestampMs: number | null;
    firstTimestampMs: number | null;
    lastTimestampMs: number | null;
    texts: string[];
    usage: TokenUsage | null;
    rawRecord: unknown;
  } | null;
};

const lastValues = <T>(set: Set<T> | Map<T, unknown>, cap: number): T[] => {
  const values = [...set.keys()];
  return values.length > cap ? values.slice(-cap) : values;
};

export const serializeTailState = (state: TailState): TailStateSnapshot => ({
  version: 1,
  turnId: state.turnId,
  outsideTimestampMs: state.outsideTimestampMs,
  taskPreviewSent: state.taskPreviewSent,
  seenMessageIds: lastValues(state.seenMessageIds, SEEN_MESSAGE_CAP),
  seenToolUseIds: lastValues(state.seenToolUseIds, SEEN_TOOL_USE_CAP),
  toolNames: lastValues(state.toolNames, TOOL_NAME_CAP).map((id) => [
    id,
    state.toolNames.get(id) ?? "unknown",
  ]),
  open: state.open
    ? {
        messageId: state.open.messageId,
        model: state.open.model,
        baseTimestampMs: state.open.baseTimestampMs,
        firstTimestampMs: state.open.firstTimestampMs,
        lastTimestampMs: state.open.lastTimestampMs,
        texts: state.open.texts,
        usage: state.open.usage,
        rawRecord: state.open.rawRecord,
      }
    : null,
});

/** Defensive restore: anything unexpected in the JSON yields null (fresh state). */
export const restoreTailState = (snapshot: unknown): TailState | null => {
  if (!isObject(snapshot) || snapshot.version !== 1) return null;
  const isOpenMessage = (v: unknown): v is OpenMessage => {
    if (!isObject(v) || !isNonEmptyString(v.messageId)) return false;
    if (!Array.isArray(v.texts)) return false;
    return true;
  };
  return {
    turnId: isNonEmptyString(snapshot.turnId) ? snapshot.turnId : null,
    outsideTimestampMs:
      typeof snapshot.outsideTimestampMs === "number"
        ? snapshot.outsideTimestampMs
        : null,
    taskPreviewSent: snapshot.taskPreviewSent === true,
    seenMessageIds: new Set(
      Array.isArray(snapshot.seenMessageIds)
        ? snapshot.seenMessageIds.filter(isNonEmptyString)
        : [],
    ),
    seenToolUseIds: new Set(
      Array.isArray(snapshot.seenToolUseIds)
        ? snapshot.seenToolUseIds.filter(isNonEmptyString)
        : [],
    ),
    toolNames: new Map(
      Array.isArray(snapshot.toolNames)
        ? snapshot.toolNames.filter(
            (pair): pair is [string, string] =>
              Array.isArray(pair) &&
              isNonEmptyString(pair[0]) &&
              isNonEmptyString(pair[1]),
          )
        : [],
    ),
    open: isOpenMessage(snapshot.open)
      ? {
          messageId: snapshot.open.messageId,
          model: isNonEmptyString(snapshot.open.model)
            ? snapshot.open.model
            : null,
          baseTimestampMs:
            typeof snapshot.open.baseTimestampMs === "number"
              ? snapshot.open.baseTimestampMs
              : null,
          firstTimestampMs:
            typeof snapshot.open.firstTimestampMs === "number"
              ? snapshot.open.firstTimestampMs
              : null,
          lastTimestampMs:
            typeof snapshot.open.lastTimestampMs === "number"
              ? snapshot.open.lastTimestampMs
              : null,
          texts: snapshot.open.texts.filter(isNonEmptyString),
          usage: usageOf(snapshot.open.usage),
          rawRecord: snapshot.open.rawRecord,
        }
      : null,
  };
};

const blocksOf = (content: unknown): Record<string, unknown>[] =>
  Array.isArray(content) ? content.filter(isObject) : [];

const recordTimestamp = (record: Record<string, unknown>): string | null =>
  isNonEmptyString(record.timestamp) ? record.timestamp : null;

/** Prompt text from string or block-array content; empty when none. */
const promptText = (content: unknown): string => {
  if (typeof content === "string") return content.trim();
  const text = blocksOf(content)
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
};

/** The prompt text of a user record (any user record; empty when none). */
export const promptTextFromRecord = (record: unknown): string => {
  if (!isObject(record)) return "";
  const message = isObject(record.message) ? record.message : null;
  return promptText(message?.content);
};

/** Tool-result text from string or block-array content; empty when none. */
const resultText = (content: unknown): string => {
  if (typeof content === "string") return content.trim();
  return promptText(content);
};

/** Local-command echoes: `/clear`, `/exit`, … the agent never answers these. */
const COMMAND_TAG = /^<(command-name|local-command-)/;

/**
 * A real user prompt opens a turn. Build noise does not: system-injected
 * records (`isMeta`), tool results, command echoes (`<command-name>`,
 * `<local-command-`), and — on builds that label input origin — anything not
 * typed by a human (`origin.kind !== "human"`, e.g. task notifications).
 */
export const isRealPromptRecord = (record: unknown): boolean => {
  if (!isObject(record) || record.type !== "user") return false;
  if (record.isMeta === true) return false;
  const message = isObject(record.message) ? record.message : null;
  const content = message?.content;
  if (blocksOf(content).some((b) => b.type === "tool_result")) return false;
  const text = promptText(content);
  const hasImages = blocksOf(content).some((b) => b.type === "image");
  if (!text && !hasImages) return false;
  if (text && COMMAND_TAG.test(text)) return false;
  const origin = record.origin;
  if (isObject(origin) && origin.kind !== undefined) {
    return origin.kind === "human";
  }
  return true; // legacy builds carry no origin — the text checks decide
};

/**
 * A session title record. Two shapes across builds: the legacy client
 * summary (`{"type":"summary","summary":"…"}`) and the modern
 * `{"type":"ai-title","aiTitle":"…"}` — neither carries a timestamp.
 */
export const metaFromRecord = (
  record: unknown,
  sessionId: string,
): SessionMetaEvent | null => {
  if (!isObject(record)) return null;
  let title: string | null = null;
  if (record.type === "summary" && isNonEmptyString(record.summary)) {
    title = record.summary;
  } else if (record.type === "ai-title" && isNonEmptyString(record.aiTitle)) {
    title = record.aiTitle;
  }
  if (title === null) return null;
  return {
    ...envelope("claude-code", sessionId, new Date().toISOString()),
    kind: "session",
    event: "meta",
    title: title.slice(0, 200),
    raw: record,
  };
};

/**
 * The transcript manifest (v2 decision 21): record types this adapter knows
 * about, inventoried from real machine transcripts (2026-09-29, builds
 * 2.1.227–2.1.284). `user`/`assistant`/`summary`/`ai-title` are normalized;
 * the rest are client bookkeeping that yields no events by design. Anything
 * else is schema drift → quarantine.
 */
export const IGNORED_RECORD_TYPES = [
  "queue-operation",
  "attachment",
  "atis-latch",
  "last-prompt",
  "mode",
  "file-history-snapshot",
  "file-history-delta",
  "system",
  "cost-state",
  "permission-mode",
] as const;

/**
 * Drift detector for one transcript record: a reason string when the record
 * is outside the supported manifest (quarantine it), null when it is known.
 */
export const driftFromRecord = (record: unknown): string | null => {
  if (!isObject(record)) return "record is not an object";
  if (record.type === undefined) return "record without a type field";
  const type = String(record.type);
  if (
    type === "user" ||
    type === "assistant" ||
    type === "summary" ||
    type === "ai-title"
  ) {
    return null;
  }
  if ((IGNORED_RECORD_TYPES as readonly string[]).includes(type)) return null;
  return `unknown record type: ${type}`;
};

/**
 * Flush the open message into its model_request — the one event per API
 * call, emitted once the message cannot grow anymore. The duration measures
 * the pre-message gap (prompt → first block, or previous tool result →
 * continuation), not inter-block streaming gaps.
 */
export const flushOpenMessage = (
  state: TailState,
  sessionId: string,
): ModelRequestEvent | null => {
  const open = state.open;
  state.open = null;
  if (!open) return null;
  state.seenMessageIds.add(open.messageId);
  const durationMs =
    open.firstTimestampMs !== null && open.baseTimestampMs !== null
      ? Math.max(0, open.firstTimestampMs - open.baseTimestampMs)
      : 0;
  if (
    open.lastTimestampMs !== null &&
    (state.outsideTimestampMs === null ||
      open.lastTimestampMs > state.outsideTimestampMs)
  ) {
    state.outsideTimestampMs = open.lastTimestampMs;
  }
  const occurredAt =
    open.lastTimestampMs !== null
      ? new Date(open.lastTimestampMs).toISOString()
      : new Date().toISOString();
  const modelRequest: ModelRequestEvent = {
    ...envelope("claude-code", sessionId, occurredAt),
    kind: "model_request",
    provider: "anthropic",
    model: open.model ?? "unknown",
    duration_ms: durationMs,
  };
  const raw = open.rawRecord;
  if (isObject(raw) && isNonEmptyString(raw.requestId)) {
    modelRequest.request_id = raw.requestId;
  }
  if (state.turnId !== null) modelRequest.turn_id = state.turnId;
  if (open.usage) modelRequest.usage = open.usage;
  const prose = open.texts.join(" ").replace(/\s+/g, " ").trim();
  if (prose) modelRequest.response_text = prose.slice(0, 2000);
  if (raw !== undefined) modelRequest.raw = raw;
  return modelRequest;
};

/** Immediate tool:call per unseen tool_use block; remembers names for results. */
const toolCallsFromBlocks = (
  state: TailState,
  sessionId: string,
  occurredAt: string,
  content: unknown,
): ToolCallEvent[] => {
  const calls: ToolCallEvent[] = [];
  for (const block of blocksOf(content)) {
    if (block.type !== "tool_use") continue;
    if (!isNonEmptyString(block.id) || !isNonEmptyString(block.name)) continue;
    if (state.seenToolUseIds.has(block.id)) continue;
    state.seenToolUseIds.add(block.id);
    state.toolNames.set(block.id, block.name);
    const call: ToolCallEvent = {
      ...envelope("claude-code", sessionId, occurredAt),
      kind: "tool",
      event: "call",
      tool_call_id: block.id,
      tool: block.name,
      raw: block,
    };
    if ("input" in block) call.args = block.input;
    calls.push(call);
  }
  return calls;
};

/**
 * One transcript record → normalized events:
 * - real user prompt  → flushes the open message, then turn:start (+ one
 *   task_preview meta, first real prompt only, + image refs/attachments)
 * - tool_result user record → tool:result (named via the earlier call,
 *   error text on failure, image attachments) — never closes the open
 *   message: results interleave between a message's own records
 * - assistant message → tool:call per tool_use block immediately; the
 *   model_request rides the message close (see flushOpenMessage)
 * - summary / ai-title → session:meta title (via metaFromRecord at the
 *   adapter layer)
 */
export const eventsFromRecord = (
  record: unknown,
  sessionId: string,
  state: TailState,
  capture?: CaptureSink,
): NormalEvent[] => {
  if (!isObject(record)) return [];
  const occurredAt = recordTimestamp(record) ?? new Date().toISOString();
  const ts = recordTimestamp(record);
  const timestampMs = ts !== null ? Date.parse(ts) : null;
  const events: NormalEvent[] = [];
  const produced: AttachmentEvent[] = []; // capture output, spliced below
  let mergedIntoOpen = false;

  if (record.type === "user") {
    const message = isObject(record.message) ? record.message : null;
    const content = message?.content;
    const results = blocksOf(content).filter((b) => b.type === "tool_result");
    if (results.length > 0) {
      for (const result of results) {
        if (!isNonEmptyString(result.tool_use_id)) continue;
        let imageShas: string[] = [];
        if (capture) {
          const captured = captureInlineImages(result.content, {
            origin: "tool_result",
            sessionId,
            occurredAt,
            seen: capture.seen,
            attachments: produced,
          });
          imageShas = captured.shas;
          events.push(...produced.splice(0));
        }
        const toolResult: ToolResultEvent = {
          ...envelope("claude-code", sessionId, occurredAt),
          kind: "tool",
          event: "result",
          tool_call_id: result.tool_use_id,
          tool: state.toolNames.get(result.tool_use_id) ?? "unknown",
          ok: result.is_error !== true,
        };
        if (result.is_error === true) {
          const error = resultText(result.content);
          if (error) toolResult.error = error.slice(0, 500);
        }
        if (imageShas.length > 0) toolResult.images = imageShas;
        events.push(toolResult);
      }
    } else if (isRealPromptRecord(record)) {
      // the prompt proves the previous message is complete
      const flushed = flushOpenMessage(state, sessionId);
      if (flushed) events.push(flushed);
      const text = promptText(content);
      const turnId = isNonEmptyString(record.uuid)
        ? record.uuid
        : `${sessionId}-${timestampMs ?? Date.now()}`;
      state.turnId = turnId;
      let images: TurnStartEvent["images"];
      if (capture) {
        const captured = captureInlineImages(content, {
          origin: "user_message",
          sessionId,
          occurredAt,
          seen: capture.seen,
          attachments: produced,
        });
        events.push(...produced.splice(0));
        if (captured.refs.length > 0)
          images = captured.refs.slice(0, MAX_IMAGES_PER_REF);
      }
      const start: TurnStartEvent = {
        ...envelope("claude-code", sessionId, occurredAt),
        kind: "turn",
        event: "start",
        turn_id: turnId,
        ...(text ? { user_message: text.slice(0, 2000) } : {}),
        ...(images ? { images } : {}),
      };
      events.push(start);
      if (!state.taskPreviewSent && text) {
        state.taskPreviewSent = true;
        const preview: SessionMetaEvent = {
          ...envelope("claude-code", sessionId, occurredAt),
          kind: "session",
          event: "meta",
          task_preview: text.slice(0, 160),
          raw: record,
        };
        events.push(preview);
      }
    }
  } else if (record.type === "assistant") {
    const message = isObject(record.message) ? record.message : null;
    if (message) {
      const messageId = isNonEmptyString(message.id)
        ? message.id
        : `${sessionId}-${isNonEmptyString(record.uuid) ? record.uuid : Date.now()}`;
      if (state.seenMessageIds.has(messageId)) {
        // already flushed (a re-read after cursor loss): prose/usage are
        // shipped, only tool calls this re-read surfaces can still be new
        events.push(
          ...toolCallsFromBlocks(state, sessionId, occurredAt, message.content),
        );
      } else {
        if (state.open && state.open.messageId !== messageId) {
          // a new message.id proves the previous message is complete
          const flushed = flushOpenMessage(state, sessionId);
          if (flushed) events.push(flushed);
        }
        if (!state.open) {
          state.open = {
            messageId,
            model: null,
            baseTimestampMs: state.outsideTimestampMs,
            firstTimestampMs: timestampMs,
            lastTimestampMs: timestampMs,
            texts: [],
            usage: null,
            rawRecord: record,
          };
        }
        mergedIntoOpen = true; // the group's own records never advance the gap
        if (isNonEmptyString(message.model)) state.open.model = message.model;
        if (timestampMs !== null) state.open.lastTimestampMs = timestampMs;
        const usage = usageOf(message.usage);
        if (usage) state.open.usage = usage;
        state.open.rawRecord = record;
        const prose = promptText(message.content);
        if (prose) state.open.texts.push(prose);
        events.push(
          ...toolCallsFromBlocks(state, sessionId, occurredAt, message.content),
        );
      }
    }
  }

  if (timestampMs !== null && !mergedIntoOpen) {
    state.outsideTimestampMs = timestampMs;
  }
  return events;
};
