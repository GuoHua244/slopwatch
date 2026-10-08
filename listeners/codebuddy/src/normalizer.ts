/**
 * CodeBuddy history messages → `NormalEvent`s.
 *
 * The mapping is deliberately mechanical and pinned to what a real session
 * produced (research/codebuddy-capture-surfaces.md §2):
 *
 * - a **user** message opens a **Turn** (its message id is the turn id — the
 *   assistant messages that follow carry no turn pointer of their own);
 * - an **assistant** message is one **Model request** plus the **tool calls**
 *   it emitted, with their results when the message already carries them
 *   (`extra.toolStatus`, which is how this agent inlines tool output);
 * - a **tool** message contributes only **tool results** — the calls that
 *   produced them were announced by the assistant message before it.
 *
 * Results are emitted once per `toolCallId` across the whole session: both
 * shapes (a `tool`-role message and the assistant's own `toolStatus`) can
 * describe the same run, and the echo would double every tool row.
 */
import {
  envelope,
  type ModelRequestEvent,
  type NormalEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type TurnStartEvent,
} from "@slopwatch/events";
import type { CapturedMessage, ToolRun } from "./transcript";
import type { UsageRecord } from "./usage";

/** The coding agent, as it reports itself in hook payloads (`client: CodeBuddyIDE`). */
export const AGENT = "codebuddy";

/**
 * Provider label for the model requests. CodeBuddy proxies its own endpoint
 * (`https://copilot.tencent.com/v2`), so unlike Claude Code there is no
 * first-party provider to name — the host is the Provider.
 */
export const PROVIDER = "codebuddy";

/** Truncation budget for captured speech (same shape as the other listeners). */
const MAX_USER_MESSAGE = 2000;
const MAX_RESPONSE_TEXT = 2000;

export type TailState = {
  /** The open turn's id — every model request and tool call belongs to it. */
  turnId: string | null;
  /** Tool results already emitted, so neither shape doubles them. */
  emittedToolResults: string[];
};

export const newTailState = (): TailState => ({
  turnId: null,
  emittedToolResults: [],
});

const okOf = (result: unknown): boolean | undefined => {
  if (typeof result !== "object" || result === null) return undefined;
  const r = result as Record<string, unknown>;
  if (r.success === true) return true;
  if (r.success === false) return false;
  if (r.status === "success") return true;
  if (r.status === "error") return false;
  return undefined;
};

const errorOf = (result: unknown): string | undefined => {
  if (typeof result !== "object" || result === null) return undefined;
  const r = result as Record<string, unknown>;
  for (const key of ["error", "message"] as const) {
    const v = r[key];
    if (typeof v === "string" && v.length > 0) return v.slice(0, 2000);
  }
  return undefined;
};

const toolResultEvent = (opts: {
  sessionId: string;
  occurredAt: string;
  toolCallId: string;
  tool: string;
  run: Pick<ToolRun, "result" | "status">;
}): ToolResultEvent => {
  const ok = okOf(opts.run.result);
  const error = ok === false ? errorOf(opts.run.result) : undefined;
  return {
    ...envelope(AGENT, opts.sessionId, opts.occurredAt),
    kind: "tool",
    event: "result",
    tool_call_id: opts.toolCallId,
    tool: opts.tool,
    ...(ok === undefined ? {} : { ok }),
    ...(error ? { error } : {}),
  };
};

export type NormalizeOptions = {
  message: CapturedMessage;
  sessionId: string;
  /** Mutated: the open turn advances and tool results are deduped. */
  state: TailState;
  /** Usage resolved for this message's step, when it has landed already. */
  usage?: UsageRecord | null;
};

export const normalizeMessage = (opts: NormalizeOptions): NormalEvent[] => {
  const { message, sessionId, state } = opts;
  const occurredAt = message.createdAt;
  const events: NormalEvent[] = [];

  if (message.role === "user") {
    const turnId = message.id;
    state.turnId = turnId;
    const text = message.text.trim();
    const turn: TurnStartEvent = {
      ...envelope(AGENT, sessionId, occurredAt),
      kind: "turn",
      event: "start",
      turn_id: turnId,
      ...(text ? { user_message: text.slice(0, MAX_USER_MESSAGE) } : {}),
    };
    events.push(turn);
    return events;
  }

  if (message.role === "assistant") {
    const modelId = message.modelId ?? message.modelName ?? "unknown";
    const request: ModelRequestEvent = {
      ...envelope(AGENT, sessionId, occurredAt),
      kind: "model_request",
      provider: PROVIDER,
      model: modelId,
      duration_ms: opts.usage?.durationMs ?? 0,
    };
    if (message.requestId) request.request_id = message.requestId;
    if (state.turnId) request.turn_id = state.turnId;
    if (opts.usage) request.usage = opts.usage.usage;
    const said = message.text.trim();
    if (said) request.response_text = said.slice(0, MAX_RESPONSE_TEXT);
    events.push(request);

    for (const call of message.toolCalls) {
      const callEvent: ToolCallEvent = {
        ...envelope(AGENT, sessionId, occurredAt),
        kind: "tool",
        event: "call",
        tool_call_id: call.toolCallId,
        tool: call.toolName,
      };
      if (call.args !== undefined) callEvent.args = call.args;
      events.push(callEvent);
    }
    for (const result of message.toolResults) {
      if (state.emittedToolResults.includes(result.toolCallId)) continue;
      state.emittedToolResults.push(result.toolCallId);
      events.push(
        toolResultEvent({
          sessionId,
          occurredAt,
          toolCallId: result.toolCallId,
          tool: result.toolName,
          run: { result: result.result },
        }),
      );
    }
    // the assistant message's own copy of each run's result — the common case
    for (const [toolCallId, run] of Object.entries(message.toolStatus)) {
      if (state.emittedToolResults.includes(toolCallId)) continue;
      if (run.result === undefined) continue;
      state.emittedToolResults.push(toolCallId);
      const called = message.toolCalls.find((c) => c.toolCallId === toolCallId);
      events.push(
        toolResultEvent({
          sessionId,
          occurredAt,
          toolCallId,
          tool: called?.toolName ?? "unknown",
          run,
        }),
      );
    }
    return events;
  }

  if (message.role === "tool") {
    for (const result of message.toolResults) {
      if (state.emittedToolResults.includes(result.toolCallId)) continue;
      state.emittedToolResults.push(result.toolCallId);
      events.push(
        toolResultEvent({
          sessionId,
          occurredAt,
          toolCallId: result.toolCallId,
          tool: result.toolName,
          run: { result: result.result },
        }),
      );
    }
  }

  return events;
};

/** Cap on how many tool-result ids one session's dedup set retains. */
export const TOOL_RESULT_MEMORY = 5_000;

export const trimTailState = (state: TailState): TailState => ({
  ...state,
  emittedToolResults: state.emittedToolResults.slice(-TOOL_RESULT_MEMORY),
});
