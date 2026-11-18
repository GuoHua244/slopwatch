import { basename } from "node:path";
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
  type TurnEndEvent,
  type TurnStartEvent,
} from "@slopwatch/events";

/**
 * The Codex rollout normalizer (listeners/codex/SPEC.md): one rollout JSONL
 * record → zero or more NormalEvents, plus the per-session TailState the
 * tail loop drives and a respawn restores from the sidecar.
 *
 * Envelope: every line is `{ timestamp, ordinal?, type, payload }`. The
 * durable transcript lives in `response_item` records; lifecycle and usage
 * ride `event_msg` (`task_started`/`task_complete`/`token_count`) and the
 * newer `token_usage_record`. The paginated `item_completed` UI mirror is
 * deliberately eventless — emitting from it would double every tool call.
 */

/** Records that produce events; anything outside both lists quarantines. */
export const KNOWN_RECORD_TYPES = [
  "session_meta",
  "response_item",
  "event_msg",
  "turn_context",
  "token_usage_record",
  "compacted",
] as const;

/** Known bookkeeping records that never produce events (no quarantine). */
export const IGNORED_RECORD_TYPES = [
  "world_state",
  "retained_context",
  "security_risk_score",
  "realtime_item",
  "inter_agent_communication",
  "dynamic_tools_updated",
] as const;

/** `response_item` payload types the adapter understands. */
const KNOWN_ITEM_TYPES = [
  "message",
  "reasoning",
  "function_call",
  "function_call_output",
  "local_shell_call",
  "local_shell_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "web_search_call",
  "image_generation_call",
  "tool_search_call",
  "tool_search_output",
  "compaction",
  "context_compaction",
  "configuration_update",
  "agent_message",
] as const;

/** `event_msg` payload types the adapter understands (both history modes). */
const KNOWN_EVENT_TYPES = [
  "task_started",
  "turn_started",
  "task_complete",
  "turn_complete",
  "turn_aborted",
  "token_count",
  "item_completed",
  "thread_settings_applied",
  "thread_goal_updated",
  "thread_rolled_back",
  // legacy history_mode only
  "user_message",
  "agent_message",
  "agent_reasoning",
  "agent_reasoning_raw_content",
  "mcp_tool_call_end",
  "web_search_end",
  "image_generation_end",
  "patch_apply_end",
  "context_compacted",
] as const;

/** Rollout files are named
 * `rollout-<YYYY-MM-DDTHH-MM-SS>-<thread-uuid>[_<rollout-uuid>].jsonl`; the
 * thread uuid comes FIRST (a revert fork appends `_<rollout-uuid>` while
 * session_meta keeps the original thread id). */
export const sessionIdFromFilename = (filename: string): string | null =>
  basename(filename).match(
    /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})/,
  )?.[1] ?? null;

const recordTimestamp = (record: Record<string, unknown>): string =>
  isNonEmptyString(record.timestamp)
    ? record.timestamp
    : new Date().toISOString();

// --- User-prompt extraction --------------------------------------------------

/**
 * Harness wrappers a user-role message may carry, one per content item:
 * AGENTS.md / environment / app context injections and the synthetic
 * `<turn_aborted>` echo. A real prompt that happens to start with "<" is
 * safe — the prefixes are specific tags, not a generic "<" test.
 */
const WRAPPER_PREFIXES = [
  "<user_instructions>",
  "<environment_context>",
  "<app-context>",
  "<skills_instructions>",
  "<permissions instructions>",
  "<collaboration_mode>",
  "<turn_aborted>",
  "# AGENTS.md instructions for",
] as const;

/** When the CLI wraps a real prompt with instructions, the user's words
 * follow this marker (upstream strip_user_message_prefix). */
const USER_MESSAGE_MARKER = "## My request for Codex:";

const isWrapperItem = (text: string): boolean =>
  WRAPPER_PREFIXES.some((prefix) => text.startsWith(prefix));

/**
 * The human's words out of one user-role `message` payload: wrapper items
 * dropped, a `## My request for Codex:`-marked item reduced to the text
 * after the marker (it wins over plain speech items), remaining items
 * joined. Null when the message carries no real speech — an
 * environment-only injection must not look like a prompt.
 */
export const realUserPrompt = (
  payload: Record<string, unknown>,
): string | null => {
  const content = payload.content;
  const items = Array.isArray(content)
    ? content.filter(isObject)
    : typeof content === "string"
      ? [{ type: "input_text", text: content }]
      : [];
  let marked: string | null = null;
  const speech: string[] = [];
  for (const item of items) {
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!text) continue;
    // the marker wins before the wrapper test: the CLI's wrapped form puts
    // the real prompt AFTER `## My request for Codex:` inside an item that
    // also starts with an instructions wrapper
    const marker = text.indexOf(USER_MESSAGE_MARKER);
    if (marker >= 0) {
      const after = text.slice(marker + USER_MESSAGE_MARKER.length).trim();
      if (after) marked = after.replace(/\s+/g, " ");
      continue;
    }
    if (isWrapperItem(text)) continue;
    speech.push(text);
  }
  const prompt = (
    marked !== null ? marked : speech.join(" ").replace(/\s+/g, " ").trim()
  ).trim();
  return prompt || null;
};

// --- Tail state ---------------------------------------------------------------

/** Insertion-ordered set with a cap: the oldest id drops when full. */
class CappedSet {
  private readonly ids = new Set<string>();
  constructor(private readonly cap: number) {}
  has(id: string): boolean {
    return this.ids.has(id);
  }
  add(id: string): void {
    if (this.ids.has(id)) return;
    if (this.ids.size >= this.cap) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    this.ids.add(id);
  }
  delete(id: string): void {
    this.ids.delete(id);
  }
  values(): string[] {
    return [...this.ids];
  }
  static restore(values: unknown, cap: number): CappedSet {
    const set = new CappedSet(cap);
    if (Array.isArray(values)) {
      for (const v of values) if (typeof v === "string") set.add(v);
    }
    return set;
  }
}

const CAPPED_TOOL_NAMES = 500;
const CAPPED_ITEM_KEYS = 2000;
const CAPPED_TURNS = 500;

export type TailState = {
  historyMode: "paginated" | "legacy" | null;
  /** Per-turn model (turn_context / thread_settings_applied). */
  currentModel: string | null;
  /** session_meta.model_provider — the ModelRequestEvent.provider. */
  currentProvider: string | null;
  /** The open turn's id (a task_started whose prompt may still be pending). */
  turnId: string | null;
  pendingTurnId: string | null;
  pendingPrompt: string | null;
  /** Assistant speech since the last usage record — the response_text. */
  lastAssistantText: string | null;
  /** Cumulative thread total_tokens high-water (revert-replay guard). */
  cumulativeTotalTokens: number;
  sawTokenUsageRecord: boolean;
  taskPreviewSent: boolean;
  titleSent: string | null;
  titleSentLegacy: boolean;
  seenTurns: CappedSet;
  endedTurns: CappedSet;
  /** call_id → tool name (function_call_output naming). */
  toolNames: Map<string, string>;
  /** `c:`/`o:`-prefixed call ids already emitted (replay guard). */
  seenItemKeys: CappedSet;
};

export const newTailState = (): TailState => ({
  historyMode: null,
  currentModel: null,
  currentProvider: null,
  turnId: null,
  pendingTurnId: null,
  pendingPrompt: null,
  lastAssistantText: null,
  cumulativeTotalTokens: 0,
  sawTokenUsageRecord: false,
  taskPreviewSent: false,
  titleSent: null,
  titleSentLegacy: false,
  seenTurns: new CappedSet(CAPPED_TURNS),
  endedTurns: new CappedSet(CAPPED_TURNS),
  toolNames: new Map(),
  seenItemKeys: new CappedSet(CAPPED_ITEM_KEYS),
});

export const serializeTailState = (state: TailState): unknown => ({
  version: 1,
  historyMode: state.historyMode,
  currentModel: state.currentModel,
  currentProvider: state.currentProvider,
  turnId: state.turnId,
  pendingTurnId: state.pendingTurnId,
  pendingPrompt: state.pendingPrompt,
  lastAssistantText: state.lastAssistantText,
  cumulativeTotalTokens: state.cumulativeTotalTokens,
  sawTokenUsageRecord: state.sawTokenUsageRecord,
  taskPreviewSent: state.taskPreviewSent,
  titleSent: state.titleSent,
  titleSentLegacy: state.titleSentLegacy,
  seenTurns: state.seenTurns.values(),
  endedTurns: state.endedTurns.values(),
  toolNames: [...state.toolNames.entries()],
  seenItemKeys: state.seenItemKeys.values(),
});

export const restoreTailState = (snapshot: unknown): TailState | null => {
  if (!isObject(snapshot) || snapshot.version !== 1) return null;
  const state = newTailState();
  if (snapshot.historyMode === "paginated" || snapshot.historyMode === "legacy")
    state.historyMode = snapshot.historyMode;
  if (isNonEmptyString(snapshot.currentModel))
    state.currentModel = snapshot.currentModel;
  if (isNonEmptyString(snapshot.currentProvider))
    state.currentProvider = snapshot.currentProvider;
  if (isNonEmptyString(snapshot.turnId)) state.turnId = snapshot.turnId;
  if (isNonEmptyString(snapshot.pendingTurnId))
    state.pendingTurnId = snapshot.pendingTurnId;
  if (isNonEmptyString(snapshot.pendingPrompt))
    state.pendingPrompt = snapshot.pendingPrompt;
  if (isNonEmptyString(snapshot.lastAssistantText))
    state.lastAssistantText = snapshot.lastAssistantText;
  if (typeof snapshot.cumulativeTotalTokens === "number")
    state.cumulativeTotalTokens = Math.max(0, snapshot.cumulativeTotalTokens);
  if (snapshot.sawTokenUsageRecord === true) state.sawTokenUsageRecord = true;
  if (snapshot.taskPreviewSent === true) state.taskPreviewSent = true;
  if (isNonEmptyString(snapshot.titleSent))
    state.titleSent = snapshot.titleSent;
  if (snapshot.titleSentLegacy === true) state.titleSentLegacy = true;
  state.seenTurns = CappedSet.restore(snapshot.seenTurns, CAPPED_TURNS);
  state.endedTurns = CappedSet.restore(snapshot.endedTurns, CAPPED_TURNS);
  if (Array.isArray(snapshot.toolNames)) {
    for (const entry of snapshot.toolNames) {
      if (
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string"
      ) {
        state.toolNames.set(entry[0], entry[1]);
      }
    }
  }
  state.seenItemKeys = CappedSet.restore(
    snapshot.seenItemKeys,
    CAPPED_ITEM_KEYS,
  );
  return state;
};

// --- Drift manifest ------------------------------------------------------------

/**
 * The rollout manifest (v2 decision 21): unknown top-level types and unknown
 * response_item/event_msg payload types are schema drift and quarantine
 * verbatim; within a known type, missing optional fields are skipped
 * leniently (Codex adds payload variants often — the ignored list keeps
 * bookkeeping records from spamming the quarantine).
 */
export const driftFromRecord = (record: unknown): string | null => {
  if (!isObject(record)) return "record is not an object";
  if (!isNonEmptyString(record.type)) return "record without a type field";
  const type = record.type;
  if ((IGNORED_RECORD_TYPES as readonly string[]).includes(type)) return null;
  if (!(KNOWN_RECORD_TYPES as readonly string[]).includes(type)) {
    return `unknown record type: ${type}`;
  }
  const payload = isObject(record.payload) ? record.payload : null;
  if (!payload) return `${type} record without a payload object`;
  if (type === "session_meta" && !isNonEmptyString(payload.id)) {
    return "session_meta without payload.id";
  }
  if (type === "response_item" && isNonEmptyString(payload.type)) {
    if (!(KNOWN_ITEM_TYPES as readonly string[]).includes(payload.type)) {
      return `unknown response_item payload type: ${payload.type}`;
    }
  }
  if (type === "event_msg" && isNonEmptyString(payload.type)) {
    if (!(KNOWN_EVENT_TYPES as readonly string[]).includes(payload.type)) {
      return `unknown event_msg payload type: ${payload.type}`;
    }
  }
  return null;
};

// --- Usage mapping --------------------------------------------------------------

const mapUsage = (usage: Record<string, unknown>): TokenUsage => {
  const out: TokenUsage = {};
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cacheRead = num(usage.cached_input_tokens);
  const cacheWrite = num(usage.cache_write_input_tokens);
  const reasoning = num(usage.reasoning_output_tokens);
  if (input !== undefined) out.input_tokens = input;
  if (output !== undefined) out.output_tokens = output;
  if (cacheRead !== undefined) out.cache_read_tokens = cacheRead;
  if (cacheWrite !== undefined) out.cache_write_tokens = cacheWrite;
  if (reasoning !== undefined) out.reasoning_tokens = reasoning;
  return out;
};

const hasUsage = (usage: TokenUsage): boolean => Object.keys(usage).length > 0;

const totalTokens = (usage: Record<string, unknown>): number =>
  typeof usage.total_tokens === "number" ? usage.total_tokens : 0;

// --- Record → events -------------------------------------------------------------

const takeResponseText = (state: TailState): string | undefined => {
  const text = state.lastAssistantText;
  state.lastAssistantText = null;
  return text ? text.slice(0, 2000) : undefined;
};

/**
 * The model_request still open at teardown: a response whose assistant
 * speech arrived but whose usage record did not (a crash mid-response, or
 * the record lands after our last drain). Emitted without usage rather than
 * lost — the Server sums model_request usage only, so an absent usage is
 * safe.
 */
export const flushOpenResponse = (
  state: TailState,
  sessionId: string,
): ModelRequestEvent | null => {
  const text = takeResponseText(state);
  if (!text) return null;
  const event: ModelRequestEvent = {
    ...envelope("codex", sessionId, new Date().toISOString()),
    kind: "model_request",
    provider: state.currentProvider ?? "unknown",
    model: state.currentModel ?? "unknown",
    duration_ms: 0,
  };
  if (state.turnId) event.turn_id = state.turnId;
  event.response_text = text;
  return event;
};

const modelRequest = (
  state: TailState,
  sessionId: string,
  occurredAt: string,
  usage: TokenUsage,
  extra: { requestId?: string; turnId?: string | null },
): ModelRequestEvent => {
  const event: ModelRequestEvent = {
    ...envelope("codex", sessionId, occurredAt),
    kind: "model_request",
    provider: state.currentProvider ?? "unknown",
    model: state.currentModel ?? "unknown",
    duration_ms: 0,
    ...(hasUsage(usage) ? { usage } : {}),
  };
  const turnId = extra.turnId ?? state.turnId;
  if (turnId) event.turn_id = turnId;
  if (extra.requestId) event.request_id = extra.requestId;
  const text = takeResponseText(state);
  if (text) event.response_text = text;
  return event;
};

/** Turn starts are emitted once per turn id; a revert-file replay is a
 * skip. A turn that started without a captured prompt opens messageless —
 * its requests still carry the turn_id. */
const turnStart = (
  state: TailState,
  sessionId: string,
  occurredAt: string,
  turnId: string,
  userMessage?: string,
): TurnStartEvent | null => {
  if (state.seenTurns.has(turnId)) return null;
  state.seenTurns.add(turnId);
  state.endedTurns.delete(turnId);
  const event: TurnStartEvent = {
    ...envelope("codex", sessionId, occurredAt),
    kind: "turn",
    event: "start",
    turn_id: turnId,
  };
  if (userMessage) event.user_message = userMessage.slice(0, 2000);
  return event;
};

const openTurnOnActivity = (
  state: TailState,
  sessionId: string,
  occurredAt: string,
): NormalEvent[] => {
  // a task_started that beat its prompt record to the tail — open the turn
  // messageless just before the first request so attribution never dangles
  const turnId = state.pendingTurnId;
  if (!turnId) return [];
  state.pendingTurnId = null;
  state.turnId = turnId;
  if (state.seenTurns.has(turnId)) return [];
  const start = turnStart(state, sessionId, occurredAt, turnId);
  return start ? [start] : [];
};

const previewFromPrompt = (
  state: TailState,
  sessionId: string,
  occurredAt: string,
  prompt: string,
): SessionMetaEvent | null => {
  if (state.taskPreviewSent) return null;
  state.taskPreviewSent = true;
  return {
    ...envelope("codex", sessionId, occurredAt),
    kind: "session",
    event: "meta",
    task_preview: prompt.slice(0, 160),
  };
};

/**
 * A real user prompt arrived: pair it with the turn we are waiting for (the
 * common order is prompt record → task_started; the reversed order opens
 * the turn here), announce the task preview once per session.
 */
const onRealPrompt = (
  state: TailState,
  sessionId: string,
  occurredAt: string,
  prompt: string,
): NormalEvent[] => {
  const events: NormalEvent[] = [];
  const preview = previewFromPrompt(state, sessionId, occurredAt, prompt);
  if (preview) events.push(preview);
  if (state.pendingTurnId) {
    const turnId = state.pendingTurnId;
    state.pendingTurnId = null;
    state.turnId = turnId;
    const start = turnStart(state, sessionId, occurredAt, turnId, prompt);
    if (start) events.push(start);
  } else {
    state.pendingPrompt = prompt;
  }
  return events;
};

const onTurnStarted = (
  state: TailState,
  sessionId: string,
  occurredAt: string,
  turnId: string,
): NormalEvent[] => {
  state.turnId = turnId;
  const prompt = state.pendingPrompt;
  state.pendingPrompt = null;
  // the common order is prompt record → task_started: open with the words.
  // A task_started with no pending prompt stays pending — the turn opens
  // with the words if the prompt record arrives (onRealPrompt), or
  // messageless at the first request/tool activity (openTurnOnActivity).
  if (prompt) {
    const start = turnStart(state, sessionId, occurredAt, turnId, prompt);
    return start ? [start] : [];
  }
  state.pendingTurnId = turnId;
  return [];
};

const onTurnEnded = (
  state: TailState,
  sessionId: string,
  occurredAt: string,
  turnId: string,
): NormalEvent[] => {
  if (!state.seenTurns.has(turnId) || state.endedTurns.has(turnId)) return [];
  state.endedTurns.add(turnId);
  const event: TurnEndEvent = {
    ...envelope("codex", sessionId, occurredAt),
    kind: "turn",
    event: "end",
    turn_id: turnId,
  };
  return [event];
};

const toolCallFromItem = (
  state: TailState,
  sessionId: string,
  occurredAt: string,
  payload: Record<string, unknown>,
  fallbackTool: string,
): ToolCallEvent | null => {
  // function_call/local_shell_call/custom_tool_call carry call_id;
  // web_search_call only carries id
  const callId = isNonEmptyString(payload.call_id)
    ? payload.call_id
    : isNonEmptyString(payload.id)
      ? payload.id
      : null;
  const name = isNonEmptyString(payload.name) ? payload.name : fallbackTool;
  if (!callId) return null;
  const key = `c:${callId}`;
  if (state.seenItemKeys.has(key)) return null;
  state.seenItemKeys.add(key);
  state.toolNames.set(callId, name);
  const call: ToolCallEvent = {
    ...envelope("codex", sessionId, occurredAt),
    kind: "tool",
    event: "call",
    tool_call_id: callId,
    tool: name,
    raw: payload,
  };
  if (typeof payload.arguments === "string") {
    try {
      call.args = JSON.parse(payload.arguments);
    } catch {
      call.args = payload.arguments;
    }
  } else if (payload.arguments !== undefined) {
    call.args = payload.arguments;
  }
  return call;
};

const toolResultFromOutput = (
  state: TailState,
  sessionId: string,
  occurredAt: string,
  payload: Record<string, unknown>,
): ToolResultEvent | null => {
  const callId = isNonEmptyString(payload.call_id) ? payload.call_id : null;
  if (!callId) return null;
  const key = `o:${callId}`;
  if (state.seenItemKeys.has(key)) return null;
  state.seenItemKeys.add(key);
  return {
    ...envelope("codex", sessionId, occurredAt),
    kind: "tool",
    event: "result",
    tool_call_id: callId,
    // there is no is_error flag on a function_call_output
    tool: state.toolNames.get(callId) ?? "unknown",
  };
};

/** Legacy `mcp_tool_call_end`: the only result record carrying ok/error. */
const toolResultFromMcp = (
  sessionId: string,
  occurredAt: string,
  payload: Record<string, unknown>,
): ToolResultEvent | null => {
  const callId = isNonEmptyString(payload.call_id) ? payload.call_id : null;
  if (!callId) return null;
  const invocation = isObject(payload.invocation) ? payload.invocation : {};
  const server = isNonEmptyString(invocation.server) ? invocation.server : null;
  const toolName = isNonEmptyString(invocation.tool)
    ? invocation.tool
    : (server ?? "unknown");
  const result: ToolResultEvent = {
    ...envelope("codex", sessionId, occurredAt),
    kind: "tool",
    event: "result",
    tool_call_id: callId,
    tool: toolName,
  };
  const duration = payload.duration;
  if (isObject(duration) && typeof duration.secs === "number") {
    const nanos = typeof duration.nanos === "number" ? duration.nanos : 0;
    result.duration_ms = Math.round(duration.secs * 1000 + nanos / 1e6);
  }
  const outcome = payload.result;
  if (isObject(outcome) && isObject(outcome.Ok)) {
    const ok = outcome.Ok;
    result.ok = ok.isError !== true;
    if (ok.isError === true) {
      const text = Array.isArray(ok.content)
        ? ok.content
            .filter(isObject)
            .map((c) => (typeof c.text === "string" ? c.text : ""))
            .join(" ")
            .replace(/\s+/g, " ")
            .trim()
        : "";
      result.error = text ? text.slice(0, 500) : "failed";
    }
  } else if (isObject(outcome) && "Err" in outcome) {
    result.ok = false;
    result.error = JSON.stringify(outcome.Err).slice(0, 500);
  }
  return result;
};

const assistantText = (payload: Record<string, unknown>): string | null => {
  const content = payload.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter(isObject)
    .filter((block) => block.type === "output_text" || block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
};

/**
 * One rollout record → normalized events. `state` is per tailed session
 * (primary plus each subagent child) and is mutated in place; the adapter
 * persists it (see adapter.ts).
 */
export const eventsFromRecord = (
  record: unknown,
  sessionId: string,
  state: TailState,
): NormalEvent[] => {
  if (!isObject(record) || !isNonEmptyString(record.type)) return [];
  const type = record.type;
  const payload = isObject(record.payload) ? record.payload : null;
  if (!payload) return [];
  const at = recordTimestamp(record);
  const events: NormalEvent[] = [];

  switch (type) {
    case "session_meta": {
      if (isNonEmptyString(payload.model_provider))
        state.currentProvider = payload.model_provider;
      if (
        payload.history_mode === "paginated" ||
        payload.history_mode === "legacy"
      )
        state.historyMode = payload.history_mode;
      return events;
    }
    case "turn_context": {
      if (isNonEmptyString(payload.model)) state.currentModel = payload.model;
      else if (
        isObject(payload.collaboration_mode) &&
        isObject(payload.collaboration_mode.settings) &&
        isNonEmptyString(payload.collaboration_mode.settings.model)
      ) {
        state.currentModel = payload.collaboration_mode.settings.model;
      }
      return events;
    }
    case "response_item": {
      const itemType = payload.type;
      switch (itemType) {
        case "message": {
          if (payload.role === "user") {
            const prompt = realUserPrompt(payload);
            if (prompt)
              events.push(...onRealPrompt(state, sessionId, at, prompt));
          } else if (payload.role === "assistant") {
            const text = assistantText(payload);
            if (text) state.lastAssistantText = text;
          }
          return events;
        }
        case "function_call": {
          const call = toolCallFromItem(
            state,
            sessionId,
            at,
            payload,
            "function",
          );
          if (call) {
            events.push(...openTurnOnActivity(state, sessionId, at));
            events.push(call);
          }
          return events;
        }
        case "function_call_output": {
          const result = toolResultFromOutput(state, sessionId, at, payload);
          if (result) events.push(result);
          return events;
        }
        case "local_shell_call": {
          const call = toolCallFromItem(
            state,
            sessionId,
            at,
            payload,
            "local_shell",
          );
          if (call) {
            events.push(...openTurnOnActivity(state, sessionId, at));
            events.push(call);
          }
          return events;
        }
        case "custom_tool_call": {
          const call = toolCallFromItem(
            state,
            sessionId,
            at,
            payload,
            "custom_tool",
          );
          if (call) {
            events.push(...openTurnOnActivity(state, sessionId, at));
            events.push(call);
          }
          return events;
        }
        case "custom_tool_call_output": {
          const result = toolResultFromOutput(state, sessionId, at, payload);
          if (result) events.push(result);
          return events;
        }
        case "web_search_call": {
          const call = toolCallFromItem(
            state,
            sessionId,
            at,
            payload,
            "web_search",
          );
          if (call) {
            events.push(...openTurnOnActivity(state, sessionId, at));
            events.push(call);
          }
          return events;
        }
        default:
          // reasoning, image_generation_call, compaction, … — no events
          return events;
      }
    }
    case "event_msg": {
      switch (payload.type) {
        case "task_started":
        case "turn_started": {
          if (isNonEmptyString(payload.turn_id)) {
            events.push(
              ...onTurnStarted(state, sessionId, at, payload.turn_id),
            );
          }
          return events;
        }
        case "task_complete":
        case "turn_complete": {
          if (isNonEmptyString(payload.turn_id)) {
            events.push(...onTurnEnded(state, sessionId, at, payload.turn_id));
          }
          return events;
        }
        case "turn_aborted": {
          if (isNonEmptyString(payload.turn_id)) {
            events.push(...onTurnEnded(state, sessionId, at, payload.turn_id));
          }
          return events;
        }
        case "token_count": {
          // once token_usage_records flow (0.169+), every token_count is the
          // same response counted twice — skip, but consume the speech
          if (state.sawTokenUsageRecord) {
            state.lastAssistantText = null;
            return events;
          }
          const info = isObject(payload.info) ? payload.info : null;
          const last =
            info && isObject(info.last_token_usage)
              ? info.last_token_usage
              : null;
          if (!last) {
            state.lastAssistantText = null;
            return events;
          }
          if (totalTokens(last) === 0) {
            state.lastAssistantText = null;
            return events; // zero-usage replay
          }
          const totals =
            info && isObject(info.total_token_usage)
              ? info.total_token_usage
              : null;
          const cumulative = totals ? totalTokens(totals) : null;
          if (cumulative !== null) {
            if (cumulative <= state.cumulativeTotalTokens) {
              state.lastAssistantText = null;
              return events;
            }
            state.cumulativeTotalTokens = cumulative;
          }
          const usage = mapUsage(last);
          if (!hasUsage(usage)) {
            state.lastAssistantText = null;
            return events;
          }
          events.push(...openTurnOnActivity(state, sessionId, at));
          // modelRequest consumes the response text it rides
          events.push(modelRequest(state, sessionId, at, usage, {}));
          return events;
        }
        case "user_message": {
          // legacy history_mode: the same prompt also rides a response_item
          // message — whichever arrives first opens the turn
          const prompt =
            typeof payload.message === "string" ? payload.message.trim() : "";
          if (prompt)
            events.push(...onRealPrompt(state, sessionId, at, prompt));
          return events;
        }
        case "agent_message": {
          const text =
            typeof payload.message === "string" ? payload.message : "";
          if (text.trim()) state.lastAssistantText = text.trim();
          return events;
        }
        case "mcp_tool_call_end": {
          const result = toolResultFromMcp(sessionId, at, payload);
          if (result) events.push(result);
          return events;
        }
        case "thread_settings_applied": {
          const settings = isObject(payload.thread_settings)
            ? payload.thread_settings
            : null;
          if (settings && isNonEmptyString(settings.model))
            state.currentModel = settings.model;
          return events;
        }
        default:
          // item_completed (the UI mirror — response items are the source of
          // truth), goal/rollback bookkeeping, legacy reasoning echoes
          return events;
      }
    }
    case "token_usage_record": {
      const usageRaw = isObject(payload.usage) ? payload.usage : null;
      state.sawTokenUsageRecord = true;
      if (!usageRaw || totalTokens(usageRaw) === 0) {
        state.lastAssistantText = null; // zero-usage replay
        return events;
      }
      const totals = isObject(payload.thread_token_usage)
        ? payload.thread_token_usage
        : null;
      const cumulative = totals ? totalTokens(totals) : null;
      if (cumulative !== null) {
        // strictly monotonic: every real response adds tokens, so an equal
        // cumulative is the same response replayed (revert forks replay
        // their prefix with lower totals)
        if (cumulative <= state.cumulativeTotalTokens) {
          state.lastAssistantText = null;
          return events;
        }
        state.cumulativeTotalTokens = cumulative;
      }
      const usage = mapUsage(usageRaw);
      if (!hasUsage(usage)) {
        state.lastAssistantText = null;
        return events;
      }
      events.push(...openTurnOnActivity(state, sessionId, at));
      // modelRequest consumes the response text it rides
      events.push(
        modelRequest(state, sessionId, at, usage, {
          requestId: isNonEmptyString(payload.response_id)
            ? payload.response_id
            : undefined,
          turnId: isNonEmptyString(payload.turn_id) ? payload.turn_id : null,
        }),
      );
      return events;
    }
    default:
      // compacted and other known types — no events
      return events;
  }
};
