/**
 * Normalize Claude Code transcript records into NormalEvents.
 *
 * Capture surface (research/coding-agent-ingestion.md, "Claude Code"): the
 * JSONL transcript at `~/.claude/projects/<cwd-hash>/<session-uuid>.jsonl`,
 * one JSON line per message event; schema undocumented, pinned defensively —
 * unknown shapes yield no events rather than throwing.
 *
 * Tool-to-turn attribution: transcript records carry no turn id, so the
 * tailer files each record under the turn opened by the latest real user
 * prompt (same positional rule the dashboard applies; see ADR 0002).
 */
import {
  envelope,
  isNonEmptyString,
  isObject,
  type ModelRequestEvent,
  type NormalEvent,
  type SessionMetaEvent,
  type TokenUsage,
  type ToolCallEvent,
  type ToolResultEvent,
  type TurnStartEvent,
} from "@slopwatch/events";

/** Cross-record tailer state; one instance per live transcript. */
export type TailState = {
  /** Turn opened by the latest real user prompt. */
  turnId: string | null;
  /** Wall-clock (ms) of the previous record, for model-request durations. */
  prevTimestampMs: number | null;
  /** Assistant message ids already emitted (streaming duplicates). */
  seenMessageIds: Set<string>;
  /** tool_call_id → tool name, so results can name their call. */
  toolNames: Map<string, string>;
  taskPreviewSent: boolean;
};

export const newTailState = (): TailState => ({
  turnId: null,
  prevTimestampMs: null,
  seenMessageIds: new Set(),
  toolNames: new Map(),
  taskPreviewSent: false,
});

const blocksOf = (content: unknown): Record<string, unknown>[] =>
  Array.isArray(content) ? content.filter(isObject) : [];

const recordTimestamp = (record: Record<string, unknown>): string | null =>
  isNonEmptyString(record.timestamp) ? record.timestamp : null;

const mapUsage = (usage: Record<string, unknown>): TokenUsage => {
  const out: TokenUsage = {};
  if (typeof usage.input_tokens === "number")
    out.input_tokens = usage.input_tokens;
  if (typeof usage.output_tokens === "number")
    out.output_tokens = usage.output_tokens;
  if (typeof usage.cache_read_input_tokens === "number")
    out.cache_read_tokens = usage.cache_read_input_tokens;
  if (typeof usage.cache_creation_input_tokens === "number")
    out.cache_write_tokens = usage.cache_creation_input_tokens;
  return out;
};

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

/**
 * A summary record (`{"type":"summary","summary":"…"}`) carries the
 * client-generated conversation title. Emits a session:meta event.
 */
export const metaFromRecord = (
  record: unknown,
  sessionId: string,
): SessionMetaEvent | null => {
  if (
    !isObject(record) ||
    record.type !== "summary" ||
    !isNonEmptyString(record.summary)
  ) {
    return null;
  }
  return {
    ...envelope("claude-code", sessionId, new Date().toISOString()),
    kind: "session",
    event: "meta",
    title: record.summary.slice(0, 200),
    raw: record,
  };
};

/**
 * The transcript manifest (v2 decision 21): record types this adapter knows
 * about, inventoried from real machine transcripts. `user`/`assistant`/
 * `summary` are normalized; the rest are client bookkeeping that yields no
 * events by design. Anything else is schema drift → quarantine.
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
  "ai-title",
] as const;

/**
 * Drift detector for one transcript record: a reason string when the record
 * is outside the supported manifest (quarantine it), null when it is known.
 */
export const driftFromRecord = (record: unknown): string | null => {
  if (!isObject(record)) return "record is not an object";
  if (record.type === undefined) return "record without a type field";
  const type = String(record.type);
  if (type === "user" || type === "assistant" || type === "summary")
    return null;
  if ((IGNORED_RECORD_TYPES as readonly string[]).includes(type)) return null;
  return `unknown record type: ${type}`;
};

/**
 * One transcript record → normalized events:
 * - real user prompt  → turn:start (+ one task_preview meta, first only)
 * - assistant message → model_request (once per message.id) + tool:call per
 *   tool_use block
 * - tool_result user record → tool:result, named via the earlier call
 */
export const eventsFromRecord = (
  record: unknown,
  sessionId: string,
  state: TailState,
): NormalEvent[] => {
  if (!isObject(record)) return [];
  const occurredAt = recordTimestamp(record) ?? new Date().toISOString();
  const ts = recordTimestamp(record);
  const timestampMs = ts !== null ? Date.parse(ts) : null;
  const events: NormalEvent[] = [];

  if (record.type === "user") {
    const message = isObject(record.message) ? record.message : null;
    const content = message?.content;
    const results = blocksOf(content).filter((b) => b.type === "tool_result");
    if (results.length > 0) {
      for (const result of results) {
        if (!isNonEmptyString(result.tool_use_id)) continue;
        const toolResult: ToolResultEvent = {
          ...envelope("claude-code", sessionId, occurredAt),
          kind: "tool",
          event: "result",
          tool_call_id: result.tool_use_id,
          tool: state.toolNames.get(result.tool_use_id) ?? "unknown",
          ok: result.is_error !== true,
        };
        events.push(toolResult);
      }
    } else if (record.isMeta !== true) {
      const text = promptText(content);
      if (text) {
        const turnId = isNonEmptyString(record.uuid)
          ? record.uuid
          : `${sessionId}-${timestampMs ?? Date.now()}`;
        state.turnId = turnId;
        const start: TurnStartEvent = {
          ...envelope("claude-code", sessionId, occurredAt),
          kind: "turn",
          event: "start",
          turn_id: turnId,
          user_message: text.slice(0, 2000),
        };
        events.push(start);
        if (!state.taskPreviewSent) {
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
    }
  } else if (record.type === "assistant") {
    const message = isObject(record.message) ? record.message : null;
    if (message) {
      const messageId = isNonEmptyString(message.id) ? message.id : null;
      const firstSeen = messageId ? !state.seenMessageIds.has(messageId) : true;
      if (messageId && firstSeen) state.seenMessageIds.add(messageId);

      if (firstSeen) {
        const durationMs =
          timestampMs !== null && state.prevTimestampMs !== null
            ? Math.max(0, timestampMs - state.prevTimestampMs)
            : 0;
        const modelRequest: ModelRequestEvent = {
          ...envelope("claude-code", sessionId, occurredAt),
          kind: "model_request",
          provider: "anthropic",
          model: isNonEmptyString(message.model) ? message.model : "unknown",
          duration_ms: durationMs,
        };
        if (isNonEmptyString(record.requestId))
          modelRequest.request_id = record.requestId;
        if (state.turnId !== null) modelRequest.turn_id = state.turnId;
        if (isObject(message.usage)) {
          const usage = mapUsage(message.usage);
          if (Object.keys(usage).length > 0) modelRequest.usage = usage;
        }
        const prose = blocksOf(message.content)
          .filter((block) => block.type === "text")
          .map((block) => (isNonEmptyString(block.text) ? block.text : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (prose) modelRequest.response_text = prose.slice(0, 2000);
        events.push(modelRequest);

        for (const block of blocksOf(message.content)) {
          if (block.type !== "tool_use") continue;
          if (!isNonEmptyString(block.id) || !isNonEmptyString(block.name))
            continue;
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
          events.push(call);
        }
      }
    }
  }

  if (timestampMs !== null) state.prevTimestampMs = timestampMs;
  return events;
};
