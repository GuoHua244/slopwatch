import { basename } from "node:path";
import {
  SCHEMA_VERSION,
  type ModelRequestEvent,
  type NormalEvent,
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
