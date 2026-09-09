import { basename } from "node:path";
import {
  SCHEMA_VERSION,
  type ModelRequestEvent,
  type NormalEvent,
  type SessionMetaEvent,
  type TokenUsage,
  type ToolCallEvent,
} from "@slopwatch/events";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

/** Rollout files are named `model-io-<sessionId>.jsonl` (sessionId includes the `sess_` prefix). */
export const sessionIdFromFilename = (filename: string): string | null =>
  basename(filename).match(/^model-io-(sess_.+)\.jsonl$/)?.[1] ?? null;

/** The record's own `sessionId` is authoritative; the filename is the fallback. */
export const resolveSessionId = (
  record: unknown,
  filename: string | null,
): string | null =>
  (isObject(record) && isNonEmptyString(record.sessionId)
    ? record.sessionId
    : null) ?? (filename ? sessionIdFromFilename(filename) : null);

const mapUsage = (usage: Record<string, unknown>): TokenUsage => {
  const out: TokenUsage = {};
  if (typeof usage.inputTokens === "number")
    out.input_tokens = usage.inputTokens;
  if (typeof usage.outputTokens === "number")
    out.output_tokens = usage.outputTokens;
  if (typeof usage.cacheReadTokens === "number")
    out.cache_read_tokens = usage.cacheReadTokens;
  if (typeof usage.cacheWriteTokens === "number")
    out.cache_write_tokens = usage.cacheWriteTokens;
  return out;
};

const recordTime = (record: Record<string, unknown>): string =>
  isNonEmptyString(record.completedAt)
    ? record.completedAt
    : new Date().toISOString();

const contentToText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(isObject)
      .filter((block) => block.type === "text")
      .map((block) => String(block.text ?? ""))
      .join(" ")
      .replace(/\s+/g, " ");
  }
  return "";
};

/**
 * User-message text with injected context blocks removed: the client stuffs
 * ambient-state / system blocks (`<in-app-browser-context>…`, tool results)
 * into user messages ahead of (or instead of) the human's words. For block
 * arrays keep only non-injection text blocks; for strings, keep everything
 * after the last closing tag of a leading block run.
 */
const userSpeech = (content: unknown): string => {
  if (Array.isArray(content)) {
    const kept = content
      .filter(isObject)
      .filter((block) => block.type === "text")
      .map((block) => String(block.text ?? "").trim())
      .filter((text) => text.length > 0 && !text.startsWith("<"));
    return kept.join(" ").replace(/\s+/g, " ").trim();
  }
  const text = contentToText(content).trim();
  if (text.startsWith("<")) {
    const afterBlocks = text
      .slice(text.lastIndexOf(">") + 1)
      .trim()
      // the client prefixes real speech with a markdown heading line
      .replace(/^(#{1,6}\s*[^\n]*\n)+/, "")
      .trim();
    return afterBlocks.replace(/\s+/g, " ");
  }
  return text.replace(/\s+/g, " ");
};

/**
 * A session_title record's response.text carries the client-generated title —
 * as a JSON string (`{"title":"…"}`) or plain text. Emits a session:meta event.
 */
export const metaFromRecord = (
  record: unknown,
  sessionId: string,
): SessionMetaEvent | null => {
  if (!isObject(record) || record.querySource !== "session_title") return null;
  const text =
    isObject(record.response) && isNonEmptyString(record.response.text)
      ? record.response.text
      : null;
  if (!text) return null;
  let title = text.trim();
  try {
    const parsed: unknown = JSON.parse(text);
    if (isObject(parsed) && isNonEmptyString(parsed.title)) {
      title = parsed.title.trim();
    }
  } catch {
    // plain text title
  }
  if (!title) return null;
  return {
    schema_version: SCHEMA_VERSION,
    agent: "zcode",
    session_id: sessionId,
    occurred_at: recordTime(record),
    kind: "session",
    event: "meta",
    title: title.slice(0, 200),
    raw: record,
  };
};

/**
 * The first main_turn record's first real user message is the session's task
 * statement — emit it once per session (caller dedupes). Messages live on
 * request.messages (not request.body); injected context blocks are stripped
 * (see userSpeech).
 */
export const taskPreviewFromRecord = (
  record: unknown,
  sessionId: string,
): SessionMetaEvent | null => {
  if (!isObject(record) || record.querySource !== "main_turn") return null;
  const messages =
    isObject(record.request) && Array.isArray(record.request.messages)
      ? record.request.messages
      : [];
  for (const message of messages) {
    if (!isObject(message) || message.role !== "user") continue;
    const text = userSpeech(message.content);
    if (!text) continue;
    return {
      schema_version: SCHEMA_VERSION,
      agent: "zcode",
      session_id: sessionId,
      occurred_at: recordTime(record),
      kind: "session",
      event: "meta",
      task_preview: text.slice(0, 160),
      raw: record,
    };
  }
  return null;
};

/**
 * One ZCode rollout record → normalized events: always a model_request, plus a
 * tool call event per response.toolCalls entry. Turn boundaries ride along as
 * `turn_id` (ZCode exposes turnId per record; turn synthesis is server-side).
 */
export const eventsFromRecord = (
  record: unknown,
  sessionId: string,
): NormalEvent[] => {
  if (!isObject(record)) return [];
  if (record.type !== undefined && record.type !== "model_io") return [];
  const model = isObject(record.model) ? record.model : null;
  if (
    !model ||
    !isNonEmptyString(model.modelId) ||
    typeof record.durationMs !== "number"
  ) {
    return [];
  }
  const startedAt = isNonEmptyString(record.startedAt)
    ? record.startedAt
    : isNonEmptyString(record.completedAt)
      ? record.completedAt
      : null;
  if (!startedAt) return [];

  const modelRequest: ModelRequestEvent = {
    schema_version: SCHEMA_VERSION,
    agent: "zcode",
    session_id: sessionId,
    occurred_at: startedAt,
    kind: "model_request",
    provider: isNonEmptyString(model.providerId) ? model.providerId : "unknown",
    model: model.modelId,
    duration_ms: record.durationMs,
    raw: record,
  };
  if (isNonEmptyString(record.requestId))
    modelRequest.request_id = record.requestId;
  if (isNonEmptyString(record.turnId)) modelRequest.turn_id = record.turnId;
  if (typeof record.attempt === "number") modelRequest.attempt = record.attempt;

  const response = isObject(record.response) ? record.response : null;
  if (response && isObject(response.usage)) {
    const usage = mapUsage(response.usage);
    if (Object.keys(usage).length > 0) modelRequest.usage = usage;
  }

  const events: NormalEvent[] = [modelRequest];

  const completedAt = isNonEmptyString(record.completedAt)
    ? record.completedAt
    : startedAt;
  const toolCalls =
    response && Array.isArray(response.toolCalls) ? response.toolCalls : [];
  for (const tc of toolCalls) {
    if (!isObject(tc) || !isNonEmptyString(tc.id) || !isNonEmptyString(tc.name))
      continue;
    const call: ToolCallEvent = {
      schema_version: SCHEMA_VERSION,
      agent: "zcode",
      session_id: sessionId,
      occurred_at: completedAt,
      kind: "tool",
      event: "call",
      tool_call_id: tc.id,
      tool: tc.name,
      raw: tc,
    };
    if ("input" in tc) call.args = tc.input;
    events.push(call);
  }
  return events;
};
