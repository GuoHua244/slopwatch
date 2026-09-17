import { createHash } from "node:crypto";

/** Version of the Listener→Server event contract. Bump on breaking changes. */
export const SCHEMA_VERSION = 1 as const;

export type TokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
};

export type Envelope = {
  schema_version: typeof SCHEMA_VERSION;
  /** Open identifier of the producing coding agent — deliberately not a closed enum. */
  agent: string;
  session_id: string;
  /** ISO 8601 timestamp of when the event occurred on the developer machine. */
  occurred_at: string;
  /** Original agent-side record, retained for fidelity and debugging. */
  raw?: unknown;
};

/** The envelope fields every event carries, built in one place. */
export const envelope = (
  agent: string,
  sessionId: string,
  occurredAt: string,
): Envelope => ({
  schema_version: SCHEMA_VERSION,
  agent,
  session_id: sessionId,
  occurred_at: occurredAt,
});

export type SessionStartEvent = Envelope & {
  kind: "session";
  event: "start";
  /** Environment facts (decision 14) — dimension fields, never identity claims. */
  cwd: string;
  hostname: string;
  git_remote?: string;
  agent_version?: string;
  /** Set on subagent sessions (child Session model). */
  parent_session_id?: string;
  spawned_by_turn_id?: string;
};

export type SessionEndEvent = Envelope & {
  kind: "session";
  event: "end";
  /** Open string: e.g. "normal", "idle-timeout" (ZCode has no SessionEnd hook). */
  reason?: string;
};

export type TurnStartEvent = Envelope & {
  kind: "turn";
  event: "start";
  turn_id: string;
  /** Set when the agent branches its turn DAG (e.g. Pi). */
  parent_turn_id?: string;
  user_message?: string;
  /**
   * Images attached to the turn's input message, in order. `n` matches the
   * `[image #n]` markers in user_message; refs without a marker render as a
   * trailing strip (image-only inputs). The bytes ride separately on
   * attachment events — refs are the render-side handles only.
   */
  images?: TurnImageRef[];
};

/** Hard cap on one captured image (decoded bytes). */
export const ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;

/** Ref cap per turn / per tool result — renders stay sane, batches bounded. */
export const MAX_IMAGES_PER_REF = 20;

export type TurnImageRef = {
  /** 1-based index matching `[image #n]` markers in the turn's user_message. */
  n: number;
  sha256: string;
  /** Decoded byte size, when known at capture time. */
  size?: number;
};

export type TurnEndEvent = Envelope & {
  kind: "turn";
  event: "end";
  turn_id: string;
  usage?: TokenUsage;
};

export type ModelRequestEvent = Envelope & {
  kind: "model_request";
  provider: string;
  model: string;
  duration_ms: number;
  request_id?: string;
  turn_id?: string;
  usage?: TokenUsage;
  attempt?: number;
  /**
   * The assistant's prose in this response, when the source record carries
   * one. Listener-truncated like turn:user_message — evidence of what the
   * agent said, not just what it did.
   */
  response_text?: string;
};

export type ToolCallEvent = Envelope & {
  kind: "tool";
  event: "call";
  tool_call_id: string;
  tool: string;
  args?: unknown;
};

/** Session-level metadata discovered while capturing (title, task preview). */
export type SessionMetaEvent = Envelope & {
  kind: "session";
  event: "meta";
  title?: string;
  task_preview?: string;
};

/**
 * Machine-generated rolling session summary. Produced by the observed
 * machine with the developer's own LLM key — a reading aid, never evidence;
 * the event stream remains the record.
 */
export type SessionSummaryEvent = Envelope & {
  kind: "session";
  event: "summary";
  /** Rolling summary text covering the whole session so far. */
  body: string;
  /** The model that produced it, e.g. "glm-4". */
  model: string;
  /**
   * Tokens the fold's LLM call spent producing `body`, in the caller's own
   * usage terms. Spend outside the agent's key: never summed into session
   * totals, displayed only as a summary cost note.
   */
  usage?: TokenUsage;
};

export type ToolResultEvent = Envelope & {
  kind: "tool";
  event: "result";
  tool_call_id: string;
  tool: string;
  duration_ms?: number;
  ok?: boolean;
  error?: string;
  /** Images the tool returned (e.g. screenshots), by sha256. */
  images?: string[];
};

/**
 * One captured image's bytes, content-addressed by sha256. The listener reads
 * the file the moment it sees the referencing record — the agent's local
 * image cache is pruned, so a path reference alone is worthless to server
 * readers. Stored in the attachments table, never in the event log; turn and
 * tool events carry the references.
 */
export type AttachmentEvent = Envelope & {
  kind: "attachment";
  sha256: string;
  mime: string;
  /** Decoded byte size — must match the base64 payload exactly. */
  size: number;
  /** base64 of the image bytes. */
  data: string;
  origin: "user_message" | "tool_result";
};

const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Integrity check beyond the structural guard: the base64 payload must decode
 * to exactly `size` bytes hashing to `sha256`. Server-side ingest runs it so
 * content addressing is earned, not claimed.
 */
export const verifyAttachment = (event: AttachmentEvent): boolean => {
  if (!SHA256_PATTERN.test(event.sha256)) return false;
  if (event.data.length > Math.ceil((ATTACHMENT_MAX_BYTES * 4) / 3) + 4)
    return false;
  const bytes = Buffer.from(event.data, "base64");
  if (bytes.length !== event.size) return false;
  return createHash("sha256").update(bytes).digest("hex") === event.sha256;
};

/**
 * A captured line the adapter could not normalize — an unknown record type,
 * a known type missing required fields, or unparsable JSON (v2 decision 21).
 * Fail open, but visible: the verbatim line rides to the Server's quarantine
 * store so schema drift shows up as a counter, not as silently missing data.
 */
export type QuarantineEvent = Envelope & {
  kind: "quarantine";
  event: "line";
  /** Why the line could not be normalized, e.g. "unknown record type: x". */
  reason: string;
  /** The verbatim line text, byte-capped (see quarantineLine). */
  line: string;
};

/** Verbatim-line budget per quarantine event; raw lines can be hundreds of KB. */
export const QUARANTINE_MAX_LINE_BYTES = 128 * 1024;

const TRUNCATION_MARKER = "…[truncated]";

export const quarantineLine = (input: {
  agent: string;
  session_id: string;
  occurred_at?: string;
  reason: string;
  line: string;
  maxLineBytes?: number;
}): QuarantineEvent => {
  const max = input.maxLineBytes ?? QUARANTINE_MAX_LINE_BYTES;
  let line = input.line;
  if (Buffer.byteLength(line, "utf8") > max) {
    // trim by chars until the utf8 encoding fits, then mark the cut
    let chars = line.length;
    while (chars > 0 && Buffer.byteLength(line.slice(0, chars), "utf8") > max) {
      chars = Math.floor(chars * 0.9);
    }
    line = `${line.slice(0, chars)}${TRUNCATION_MARKER}`;
  }
  return {
    schema_version: SCHEMA_VERSION,
    agent: input.agent,
    session_id: input.session_id,
    occurred_at: input.occurred_at ?? new Date().toISOString(),
    kind: "quarantine",
    event: "line",
    reason: input.reason,
    line,
  };
};

export type NormalEvent =
  | SessionStartEvent
  | SessionEndEvent
  | SessionMetaEvent
  | SessionSummaryEvent
  | TurnStartEvent
  | TurnEndEvent
  | ModelRequestEvent
  | ToolCallEvent
  | ToolResultEvent
  | AttachmentEvent
  | QuarantineEvent;

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

const isNonNegativeNumber = (v: unknown): boolean =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Token counts are summed into Postgres bigint columns both at ingest and on
 * every rollup recompute — a fractional or beyond-2^53 value would fail the
 * `::bigint` cast and poison recomputes/backfills for that data forever. */
const isTokenCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

const isOptional = (v: unknown, pred: (v: unknown) => boolean): boolean =>
  v === undefined || pred(v);

const TOKEN_USAGE_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
] as const;

const isTokenUsage = (v: unknown): v is TokenUsage =>
  isObject(v) &&
  Object.entries(v).every(
    ([key, n]) =>
      (TOKEN_USAGE_KEYS as readonly string[]).includes(key) && isTokenCount(n),
  );

const isOneOf =
  <T extends string>(values: readonly T[]) =>
  (v: unknown): boolean =>
    typeof v === "string" && (values as readonly string[]).includes(v);

const isLifecycleEvent = isOneOf(["start", "end"] as const);
const isToolPhase = isOneOf(["call", "result"] as const);
const isImageMime = isOneOf(IMAGE_MIME_TYPES);
const isSha256 = (v: unknown): v is string =>
  typeof v === "string" && SHA256_PATTERN.test(v);

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

const isImageRefList = (v: unknown): boolean =>
  Array.isArray(v) &&
  v.length <= MAX_IMAGES_PER_REF &&
  v.every(
    (ref) =>
      isObject(ref) &&
      isTokenCount(ref.n) &&
      ref.n >= 1 &&
      isSha256(ref.sha256) &&
      isOptional(ref.size, isTokenCount) &&
      Object.keys(ref).every((k) => ["n", "sha256", "size"].includes(k)),
  );

const isShaList = (v: unknown): boolean =>
  Array.isArray(v) &&
  v.length <= MAX_IMAGES_PER_REF &&
  v.every((sha) => isSha256(sha));

/** Runtime type guard for a NormalEvent. Strict: unknown keys in usage fail. */
export const isNormalEvent = (value: unknown): value is NormalEvent => {
  if (!isObject(value)) return false;
  if (value.schema_version !== SCHEMA_VERSION) return false;
  if (!isNonEmptyString(value.agent)) return false;
  if (!isNonEmptyString(value.session_id)) return false;
  if (
    typeof value.occurred_at !== "string" ||
    Number.isNaN(Date.parse(value.occurred_at))
  ) {
    return false;
  }
  switch (value.kind) {
    case "session": {
      if (value.event === "meta") {
        if (!isOptional(value.title, isNonEmptyString)) return false;
        if (!isOptional(value.task_preview, isNonEmptyString)) return false;
        return value.title !== undefined || value.task_preview !== undefined;
      }
      if (value.event === "summary") {
        if (!isNonEmptyString(value.body) || !isNonEmptyString(value.model))
          return false;
        return isOptional(value.usage, isTokenUsage);
      }
      if (!isLifecycleEvent(value.event)) return false;
      if (value.event === "start") {
        if (!isNonEmptyString(value.cwd) || !isNonEmptyString(value.hostname))
          return false;
        if (!isOptional(value.git_remote, isNonEmptyString)) return false;
        if (!isOptional(value.agent_version, isNonEmptyString)) return false;
        if (!isOptional(value.parent_session_id, isNonEmptyString))
          return false;
        if (!isOptional(value.spawned_by_turn_id, isNonEmptyString))
          return false;
      } else if (!isOptional(value.reason, isNonEmptyString)) {
        return false;
      }
      return true;
    }
    case "turn": {
      if (!isLifecycleEvent(value.event)) return false;
      if (!isNonEmptyString(value.turn_id)) return false;
      if (!isOptional(value.parent_turn_id, isNonEmptyString)) return false;
      if (!isOptional(value.user_message, isNonEmptyString)) return false;
      if (!isOptional(value.usage, isTokenUsage)) return false;
      if (!isOptional(value.images, isImageRefList)) return false;
      return true;
    }
    case "model_request": {
      if (!isNonEmptyString(value.provider) || !isNonEmptyString(value.model))
        return false;
      if (!isNonNegativeNumber(value.duration_ms)) return false;
      if (!isOptional(value.request_id, isNonEmptyString)) return false;
      if (!isOptional(value.turn_id, isNonEmptyString)) return false;
      if (!isOptional(value.usage, isTokenUsage)) return false;
      if (!isOptional(value.attempt, isNonNegativeNumber)) return false;
      if (!isOptional(value.response_text, isNonEmptyString)) return false;
      return true;
    }
    case "tool": {
      if (!isToolPhase(value.event)) return false;
      if (
        !isNonEmptyString(value.tool_call_id) ||
        !isNonEmptyString(value.tool)
      )
        return false;
      if (!isOptional(value.duration_ms, isNonNegativeNumber)) return false;
      if (!isOptional(value.ok, (v) => typeof v === "boolean")) return false;
      if (!isOptional(value.error, isNonEmptyString)) return false;
      if (!isOptional(value.images, isShaList)) return false;
      return true;
    }
    case "attachment": {
      if (!isNonEmptyString(value.sha256) || !isSha256(value.sha256))
        return false;
      if (!isImageMime(value.mime)) return false;
      const size = value.size;
      if (!isTokenCount(size) || size < 1 || size > ATTACHMENT_MAX_BYTES)
        return false;
      if (
        typeof value.data !== "string" ||
        value.data.length === 0 ||
        value.data.length > Math.ceil((ATTACHMENT_MAX_BYTES * 4) / 3) + 4 ||
        !BASE64_PATTERN.test(value.data)
      )
        return false;
      return isOneOf(["user_message", "tool_result"] as const)(value.origin);
    }
    case "quarantine": {
      if (value.event !== "line") return false;
      if (!isNonEmptyString(value.reason)) return false;
      if (!isNonEmptyString(value.line)) return false;
      // The listener caps quarantine lines before sending, but validation is
      // the server's only defense — an uncapped line lands verbatim in
      // Postgres inside the ingest transaction.
      if (Buffer.byteLength(value.line, "utf8") > QUARANTINE_MAX_LINE_BYTES)
        return false;
      return true;
    }
    default:
      return false;
  }
};

/**
 * Join an API base URL and an absolute path: trailing slashes are stripped
 * from the base and exactly one separator is inserted, so either
 * `joinUrl("http://x/", "/v1")` or `joinUrl("http://x", "/v1")` yields
 * "http://x/v1".
 */
export const joinUrl = (base: string, path: string): string =>
  `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

export type SendEventsOptions = {
  /** Base URL of the Slopwatch Server, e.g. "http://localhost:8787". */
  serverUrl: string;
  /** Admin-minted bearer token (decision 6). */
  token: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Abort the POST when the server accepts but never answers (a black-holed
   * connection would otherwise hang the listener forever). Default 30s. */
  timeoutMs?: number;
};

/** A send the server actively rejected. `status` lets the disk queue tell a
 * permanent rejection (drop the batch, keep flowing) from a transient one
 * (leave it queued for replay). */
export class SendError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`sendEvents: server responded ${status}`);
    this.name = "SendError";
    this.status = status;
  }
}

/**
 * Ship a batch of events to the Server. Failure behavior: throw and let the
 * caller decide — the live listeners queue failed batches to a disk-backed
 * offline buffer (@slopwatch/buffer) and replay them on a later flush.
 */
export const sendEvents = async (
  events: NormalEvent[],
  opts: SendEventsOptions,
): Promise<void> => {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(joinUrl(opts.serverUrl, "/events"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify({ schema_version: SCHEMA_VERSION, events }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  if (!res.ok) {
    throw new SendError(res.status);
  }
};
