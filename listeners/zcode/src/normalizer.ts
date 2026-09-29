import { basename } from "node:path";
import {
  envelope,
  isNonEmptyString,
  isObject,
  type AttachmentEvent,
  type ModelRequestEvent,
  type NormalEvent,
  type SessionMetaEvent,
  type TokenUsage,
  type ToolCallEvent,
  type ToolResultEvent,
  type TurnFileRef,
  type TurnStartEvent,
} from "@slopwatch/events";
import {
  blockImagePaths,
  captureToolResultImages,
  captureUserMessageImages,
  hasImageBlock,
  type AttachmentCapture,
} from "./images";
import {
  FILE_PLACEHOLDER,
  FILE_PLACEHOLDER_SCAN,
  attachedFilePath,
  captureFileCandidates,
  fileMarker,
  hasFileBlock,
  userFileCandidates,
} from "./files";

/**
 * The caller-owned capture state threaded through the normalizer: the sha
 * dedup set, an injectable reader, and the OUT list of attachment events.
 * The origin is supplied per extraction point (turn input vs tool result).
 */
export type AttachmentCaptureState = {
  sessionId: string;
  occurredAt: string;
  seen: Set<string>;
  readFile?: (path: string) => Buffer | null;
  attachments: AttachmentEvent[];
};

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
 * Strip a leading run of injected XML-ish blocks ("<tag …>…</tag>"), each
 * matched lazily to its own closing tag — real speech after the blocks may
 * itself contain '>' (e.g. "=>"), so a global last-closing-tag cut would eat
 * the human's words.
 */
const stripLeadingBlocks = (text: string): string => {
  let rest = text;
  for (;;) {
    const m = rest.match(/^<[A-Za-z][^<>]*>[\s\S]*?<\/[A-Za-z][^<>]*>\s*/);
    if (!m) return rest.trim();
    rest = rest.slice(m[0].length);
  }
};

/**
 * The text blocks of a block-array user message that read as human speech:
 * type:"text", non-empty, not an injected "<tag …>" block. `userSpeech` joins
 * these; the file pass rewrites some of them into `[file #n]` markers.
 */
const speechBlocks = (content: unknown): string[] | null => {
  if (!Array.isArray(content)) return null;
  return content
    .filter(isObject)
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? "").trim())
    .filter((text) => text.length > 0 && !text.startsWith("<"));
};

/**
 * User-message text with injected context blocks removed: the client stuffs
 * ambient-state / system blocks (`<in-app-browser-context>…`, tool results)
 * into user messages ahead of (or instead of) the human's words. For block
 * arrays keep only non-injection text blocks; for strings, strip the leading
 * block run and keep whatever the human actually wrote.
 */
/** One speech-assembly rule for every path that turns blocks into message
 * text — plain speech and file-marker-rewritten speech must stay identical. */
const joinSpeech = (blocks: string[]): string =>
  blocks.join(" ").replace(/\s+/g, " ").trim();

const userSpeech = (content: unknown): string => {
  const blocks = speechBlocks(content);
  if (blocks !== null) return joinSpeech(blocks);
  const text = contentToText(content).trim();
  if (text.startsWith("<")) {
    const afterBlocks = stripLeadingBlocks(text)
      // the client prefixes real speech with a markdown heading line
      .replace(/^(#{1,6}\s*[^\n]*\n)+/, "")
      .trim();
    return afterBlocks.replace(/\s+/g, " ");
  }
  return text.replace(/\s+/g, " ");
};

/**
 * File pass over a block-array turn input: capture the file candidates'
 * bytes, then rewrite the speech text so each captured reference becomes a
 * `[file #n]` marker — `[PDF: source: <path>]` placeholders are rewritten
 * inline, a whole `Attached <mime>: <path>` block collapses to its marker.
 * Failed captures keep their original text (the dashboard shows the raw
 * path). The synthetic "Called the Read tool …" transcripts of text
 * attachments ride in the text itself and are left untouched.
 */
const captureUserMessageFiles = (
  content: unknown,
  capture: AttachmentCapture,
): { text: string; refs: TurnFileRef[] } => {
  const blocks = speechBlocks(content) ?? [];
  const { refs, refByPath } = captureFileCandidates(
    userFileCandidates(content),
    capture,
  );
  const text = blocks.map((block) => {
    let replaced = false;
    const rewritten = block.replace(FILE_PLACEHOLDER, (original, path) => {
      const ref = refByPath.get(path);
      if (ref === undefined) return original;
      replaced = true;
      return fileMarker(ref.n);
    });
    if (replaced) return rewritten;
    const attachedPath = attachedFilePath(block);
    if (attachedPath !== null) {
      const ref = refByPath.get(attachedPath);
      if (ref !== undefined) return fileMarker(ref.n);
    }
    return block;
  });
  return { text: joinSpeech(text), refs };
};

/**
 * The raw (untruncated) title a session_title record's response.text carries
 * — as a JSON string (`{"title":"…"}`) or plain text — or null. The title
 * gate compares these full strings so a retitle that only differs past the
 * event's 200-char cap still counts as a retitle.
 */
export const titleTextFromRecord = (record: unknown): string | null => {
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
  return title || null;
};

/**
 * A session_title record's response.text carries the client-generated title —
 * as a JSON string (`{"title":"…"}`) or plain text. Emits a session:meta event.
 */
export const metaFromRecord = (
  record: unknown,
  sessionId: string,
): SessionMetaEvent | null => {
  // re-narrow for recordTime — the title extraction did its own narrowing
  if (!isObject(record)) return null;
  const title = titleTextFromRecord(record);
  if (title === null) return null;
  return {
    ...envelope("zcode", sessionId, recordTime(record)),
    kind: "session",
    event: "meta",
    title: title.slice(0, 200),
    raw: record,
  };
};

/**
 * A text block that exists to transport a file rather than to speak: an
 * `Attached <mime>: <path>` marker line, a bare `[PDF: source: <path>]`
 * placeholder, or a synthetic "Called the Read tool …" transcript.
 */
const isFileTransportNoise = (block: string): boolean =>
  attachedFilePath(block) !== null ||
  FILE_PLACEHOLDER_SCAN.test(block) ||
  block.startsWith("Called the Read tool");

/**
 * The first main_turn record's first real user message is the session's task
 * statement — emit it once per session (caller dedupes). Messages live on
 * request.messages (not request.body); injected context blocks are stripped
 * (see userSpeech), and file-transport noise (`Attached …` lines,
 * `[PDF: source: …]` placeholders, synthetic Read transcripts) is skipped so
 * the preview stays readable — attachment-only messages yield no preview.
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
    const blocks = speechBlocks(message.content);
    const text = (
      blocks !== null
        ? blocks.filter((block) => !isFileTransportNoise(block))
        : [userSpeech(message.content)]
    )
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    return {
      ...envelope("zcode", sessionId, recordTime(record)),
      kind: "session",
      event: "meta",
      task_preview: text.slice(0, 160),
      raw: record,
    };
  }
  return null;
};

/**
 * A turn's human input, extracted on the turn's FIRST model_io record only
 * (callers dedupe via seenTurns). Later turns' request.messages repeat earlier
 * history, so the last real user message is the new input; injected context
 * blocks are stripped (see userSpeech). ZCode has no turn-end record, so no
 * turn:end is emitted — the dashboard pairs this with the turn_id already
 * riding on model_request events.
 *
 * With a capture context, the input message's `[Image: source: <path>]`
 * placeholders are rewritten to `[image #n]` markers and its file references
 * (`{type:"file"}` blocks, `Attached <mime>: <path>` lines) to `[file #n]`
 * markers; the bytes ship as attachment events (see images.ts / files.ts) and
 * the event carries the render refs. Unreadable references keep their
 * original text — the dashboard shows those as not archived.
 */
export const turnStartFromRecord = (
  record: unknown,
  sessionId: string,
  seenTurns: Set<string>,
  capture?: AttachmentCaptureState,
): TurnStartEvent | null => {
  if (!isObject(record) || record.type !== "model_io") return null;
  if (!isNonEmptyString(record.turnId) || seenTurns.has(record.turnId))
    return null;
  seenTurns.add(record.turnId);
  const messages =
    isObject(record.request) && Array.isArray(record.request.messages)
      ? record.request.messages
      : [];
  let userMessage: string | null = null;
  let chosenContent: unknown = null;
  let imageOnlyContent: unknown = null;
  for (const message of messages) {
    if (!isObject(message) || message.role !== "user") continue;
    const text = userSpeech(message.content);
    if (text) {
      userMessage = text.slice(0, 2000);
      chosenContent = message.content;
    } else if (
      hasImageBlock(message.content) ||
      hasFileBlock(message.content)
    ) {
      // Attachment-only inputs speak through their attachments instead.
      // Last wins — history re-echoes earlier turns, so the first hit is
      // often an old turn's input, not this one's.
      imageOnlyContent = message.content;
    }
  }
  const event: TurnStartEvent = {
    ...envelope(
      "zcode",
      sessionId,
      isNonEmptyString(record.startedAt)
        ? record.startedAt
        : recordTime(record),
    ),
    kind: "turn",
    event: "start",
    turn_id: record.turnId,
  };
  if (capture) {
    const content = chosenContent ?? imageOnlyContent;
    if (content !== null) {
      // File pass first, at block level: `Attached …` blocks and
      // `[PDF: source: …]` placeholders only survive text assembly as
      // markers if they are rewritten before the whitespace-collapsing
      // join. Then the image pass rewrites the assembled text as before.
      let baseText = userMessage ?? "";
      let fileRefs: TurnFileRef[] | undefined;
      if (Array.isArray(content)) {
        const filePass = captureUserMessageFiles(content, {
          ...capture,
          sessionId,
          origin: "user_message",
        });
        baseText = filePass.text;
        fileRefs = filePass.refs;
      }
      const captured = captureUserMessageImages(
        baseText,
        blockImagePaths(content),
        // the record's session id is authoritative for everything it emits
        { ...capture, sessionId, origin: "user_message" },
      );
      const capturedText = captured.text.trim();
      if (capturedText) event.user_message = capturedText.slice(0, 2000);
      else if (userMessage) event.user_message = userMessage;
      if (captured.refs.length > 0) event.images = captured.refs;
      if (fileRefs !== undefined && fileRefs.length > 0) event.files = fileRefs;
    } else if (userMessage) {
      event.user_message = userMessage;
    }
  } else if (userMessage) {
    event.user_message = userMessage;
  }
  return event;
};

/**
 * The rollout manifest (v2 decision 21): the record types this adapter
 * handles, from real machine files — model-io rollout files carry only
 * `model_io` records today. Any other type (or a typeless record) is schema
 * drift: it goes to the quarantine instead of vanishing silently.
 */
export const KNOWN_RECORD_TYPES = ["model_io"] as const;

/**
 * Drift detector for one rollout record: a reason string when the record is
 * outside the supported manifest (quarantine it), null when it is a known
 * type (normalize it as today — within-type variance stays lenient, the
 * strict guard in eventsFromRecord already skips empty parses).
 */
export const driftFromRecord = (record: unknown): string | null => {
  if (!isObject(record)) return "record is not an object";
  if (record.type === undefined) return "record without a type field";
  if (record.type !== "model_io") {
    return `unknown record type: ${String(record.type)}`;
  }
  const model = isObject(record.model) ? record.model : null;
  if (!model || !isNonEmptyString(model.modelId)) {
    return "model_io record without model.modelId";
  }
  if (typeof record.durationMs !== "number") {
    return "model_io record without durationMs";
  }
  if (
    !isNonEmptyString(record.startedAt) &&
    !isNonEmptyString(record.completedAt)
  ) {
    return "model_io record without a timestamp";
  }
  return null;
};

/**
 * One ZCode rollout record → normalized events: always a model_request, plus a
 * tool call event per response.toolCalls entry. Turn boundaries ride along as
 * `turn_id` (ZCode exposes turnId per record; the turn's start event with the
 * user's words comes from turnStartFromRecord).
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
    ...envelope("zcode", sessionId, startedAt),
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
  // Title-generation requests echo a JSON title payload in response.text —
  // metadata, not agent speech, so it must not ride along as an answer.
  if (
    record.querySource !== "session_title" &&
    response &&
    isNonEmptyString(response.text)
  ) {
    modelRequest.response_text = response.text.slice(0, 2000);
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
      ...envelope("zcode", sessionId, completedAt),
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

/**
 * The results of a turn's earlier tool calls, extracted from this record's
 * request history: ZCode echoes every prior tool result into
 * request.messages as `{role: "tool", content, toolCallId, toolName,
 * isError}` (camelCase — the provider body's own shape). Callers dedupe via
 * seenToolResults: later records repeat earlier results verbatim. The final
 * calls of a session have no follow-up request, so they legitimately stay
 * without a result.
 *
 * With a capture context, image blocks in a tool result (screenshots) ship
 * as attachment events and the result carries their sha references.
 */
export const toolResultsFromRecord = (
  record: unknown,
  sessionId: string,
  seenToolResults: Set<string>,
  capture?: AttachmentCaptureState,
): ToolResultEvent[] => {
  if (!isObject(record) || record.type !== "model_io") return [];
  const messages =
    isObject(record.request) && Array.isArray(record.request.messages)
      ? record.request.messages
      : [];
  const results: ToolResultEvent[] = [];
  for (const message of messages) {
    if (!isObject(message) || message.role !== "tool") continue;
    if (
      !isNonEmptyString(message.toolCallId) ||
      seenToolResults.has(message.toolCallId)
    ) {
      continue;
    }
    seenToolResults.add(message.toolCallId);
    const result: ToolResultEvent = {
      ...envelope("zcode", sessionId, recordTime(record)),
      kind: "tool",
      event: "result",
      tool_call_id: message.toolCallId,
      tool: isNonEmptyString(message.toolName) ? message.toolName : "unknown",
      ok: message.isError !== true,
    };
    if (message.isError === true) {
      const detail = contentToText(message.content).replace(/\s+/g, " ").trim();
      result.error = detail ? detail.slice(0, 500) : "failed";
    }
    if (capture) {
      const shas = captureToolResultImages(message.content, {
        ...capture,
        sessionId,
        origin: "tool_result",
      });
      if (shas.length > 0) result.images = shas;
    }
    results.push(result);
  }
  return results;
};
