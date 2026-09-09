/** Version of the Listener→Server event contract. Bump on breaking changes. */
export const SCHEMA_VERSION = 1 as const;

export type TokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
};

type Envelope = {
  schema_version: typeof SCHEMA_VERSION;
  /** Open identifier of the producing coding agent — deliberately not a closed enum. */
  agent: string;
  session_id: string;
  /** ISO 8601 timestamp of when the event occurred on the developer machine. */
  occurred_at: string;
  /** Original agent-side record, retained for fidelity and debugging. */
  raw?: unknown;
};

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
};

export type ToolCallEvent = Envelope & {
  kind: "tool";
  event: "call";
  tool_call_id: string;
  tool: string;
  args?: unknown;
};

export type ToolResultEvent = Envelope & {
  kind: "tool";
  event: "result";
  tool_call_id: string;
  tool: string;
  duration_ms?: number;
  ok?: boolean;
  error?: string;
};

export type NormalEvent =
  | SessionStartEvent
  | SessionEndEvent
  | TurnStartEvent
  | TurnEndEvent
  | ModelRequestEvent
  | ToolCallEvent
  | ToolResultEvent;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): boolean =>
  typeof v === "string" && v.length > 0;

const isNonNegativeNumber = (v: unknown): boolean =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

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
      (TOKEN_USAGE_KEYS as readonly string[]).includes(key) &&
      isNonNegativeNumber(n),
  );

const isOneOf =
  <T extends string>(values: readonly T[]) =>
  (v: unknown): boolean =>
    typeof v === "string" && (values as readonly string[]).includes(v);

const isLifecycleEvent = isOneOf(["start", "end"] as const);
const isToolPhase = isOneOf(["call", "result"] as const);

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
      return true;
    }
    default:
      return false;
  }
};

export type SendEventsOptions = {
  /** Base URL of the Slopwatch Server, e.g. "http://localhost:8787". */
  serverUrl: string;
  /** Admin-minted bearer token (decision 6). */
  token: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
};

/**
 * Ship a batch of events to the Server. v0 failure behavior: throw and let the
 * caller drop the batch (open question 4) — no retry, no local buffering yet.
 */
export const sendEvents = async (
  events: NormalEvent[],
  opts: SendEventsOptions,
): Promise<void> => {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${opts.serverUrl.replace(/\/+$/, "")}/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify({ schema_version: SCHEMA_VERSION, events }),
  });
  if (!res.ok) {
    throw new Error(`sendEvents: server responded ${res.status}`);
  }
};
