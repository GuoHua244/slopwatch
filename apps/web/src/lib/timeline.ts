import type {
  ModelRequestEvent,
  SessionEndEvent,
  SessionStartEvent,
  SessionMetaEvent,
  SessionSummaryEvent,
  ToolCallEvent,
  ToolResultEvent,
  TokenUsage,
  TurnFileRef,
  TurnImageRef,
} from "@slopwatch/events";
import type { StoredEvent } from "../api";
import { summarizeArgs } from "./format";

/** A tool call and (when it has arrived) its result, paired by tool_call_id. */
export type ToolActivity = {
  call?: ToolCallEvent;
  result?: ToolResultEvent;
};

/** One turn: the user-visible cycle of user message → requests + tool loops. */
export type TurnActivity = {
  turnId: string;
  userMessage?: string;
  /** The turn's answer: the last non-empty assistant prose seen in it. */
  assistantMessage?: string;
  /** The turn's input images, in `[image #n]` marker order. */
  images?: TurnImageRef[];
  /** The turn's input files, in `[file #n]` marker order. */
  files?: TurnFileRef[];
  startedAt?: string;
  endedAt?: string;
  /** Turn-end usage when the agent emits one; otherwise derived by summing
   * the turn's model requests (ZCode has no turn-end record). */
  usage?: TokenUsage;
  modelRequests: ModelRequestEvent[];
  tools: ToolActivity[];
};

/** Everything a session view needs, grouped for the DRI's turn lens. */
export type SessionTimeline = {
  starts: SessionStartEvent[];
  ends: SessionEndEvent[];
  metas: SessionMetaEvent[];
  /** Rolling machine-generated summaries, in emission order. */
  summaries: SessionSummaryEvent[];
  /** First-appearance order; turns without a start event are synthesized. */
  turns: TurnActivity[];
  orphans: { requests: ModelRequestEvent[]; tools: ToolActivity[] };
};

/**
 * Build the session timeline from stored events. Today's listeners do not all
 * emit turn start/end events, so a turn is also synthesized on first sight of
 * an unknown turn_id on a request or tool event.
 */
export const buildTimeline = (events: StoredEvent[]): SessionTimeline => {
  const timeline: SessionTimeline = {
    starts: [],
    ends: [],
    metas: [],
    summaries: [],
    turns: [],
    orphans: { requests: [], tools: [] },
  };
  const turnsById = new Map<string, TurnActivity>();
  const toolsById = new Map<string, ToolActivity>();
  // Tool events carry no turn_id (schema), so they are filed under the turn
  // of the latest preceding turn:start or attributed model request. This is
  // exact for linear turn DAGs; branching sessions (Pi) are approximated.
  let currentTurnId: string | null = null;

  const turnFor = (turnId: string | undefined): TurnActivity | null => {
    if (!turnId) return null;
    let turn = turnsById.get(turnId);
    if (!turn) {
      turn = { turnId, modelRequests: [], tools: [] };
      turnsById.set(turnId, turn);
      timeline.turns.push(turn);
    }
    return turn;
  };

  const fileTool = (turnId: string | null, activity: ToolActivity): void => {
    const turn = turnFor(turnId ?? undefined);
    if (turn) turn.tools.push(activity);
    else timeline.orphans.tools.push(activity);
  };

  const ordered = [...events].sort((a, b) => a.event_seq - b.event_seq);
  for (const { event } of ordered) {
    switch (event.kind) {
      case "session":
        if (event.event === "start") timeline.starts.push(event);
        else if (event.event === "meta") timeline.metas.push(event);
        else if (event.event === "summary") timeline.summaries.push(event);
        else timeline.ends.push(event);
        break;
      case "turn": {
        if (event.event === "start") {
          currentTurnId = event.turn_id;
          const turn = turnFor(event.turn_id);
          if (turn) {
            turn.userMessage = event.user_message;
            turn.images = event.images;
            turn.files = event.files;
            turn.startedAt = event.occurred_at;
          }
        } else {
          const turn = turnsById.get(event.turn_id);
          if (turn) {
            turn.endedAt = event.occurred_at;
            turn.usage = event.usage;
          }
        }
        break;
      }
      case "model_request": {
        if (event.turn_id) currentTurnId = event.turn_id;
        // A request without its own turn_id rides the turn already open —
        // the same rule tool events file under. This is what a claude-code
        // subagent's respawned tail used to produce (its attribution state
        // was dropped on session:end); without the fallback its whole
        // transcript lands in orphans and the review view shows no answers.
        const turn = turnFor(event.turn_id ?? currentTurnId ?? undefined);
        if (turn) {
          turn.modelRequests.push(event);
          // Requests arrive in seq order, so the final prose of the turn wins.
          if (event.response_text) turn.assistantMessage = event.response_text;
        } else {
          timeline.orphans.requests.push(event);
        }
        break;
      }
      case "tool": {
        const id = event.tool_call_id;
        let activity = toolsById.get(id);
        const isNew = activity === undefined;
        if (!activity) {
          activity = {};
          toolsById.set(id, activity);
        }
        if (event.event === "call") activity.call = event;
        else activity.result = event;
        // File an activity once, at first sighting; the paired half updates
        // the same object wherever it lands.
        if (isNew) fileTool(currentTurnId, activity);
        break;
      }
    }
  }
  // Turns whose agent never emits turn:end (ZCode) get their consumption
  // derived from the requests they contain — the same numbers the Usage
  // panel sums per session.
  for (const turn of timeline.turns) {
    if (turn.usage !== undefined || turn.modelRequests.length === 0) continue;
    const summed: TokenUsage = {};
    for (const request of turn.modelRequests) {
      summed.input_tokens =
        (summed.input_tokens ?? 0) + (request.usage?.input_tokens ?? 0);
      summed.output_tokens =
        (summed.output_tokens ?? 0) + (request.usage?.output_tokens ?? 0);
      summed.cache_read_tokens =
        (summed.cache_read_tokens ?? 0) +
        (request.usage?.cache_read_tokens ?? 0);
      summed.cache_write_tokens =
        (summed.cache_write_tokens ?? 0) +
        (request.usage?.cache_write_tokens ?? 0);
    }
    turn.usage = summed;
  }
  return timeline;
};

/** Merge an incremental page (decision 8) into the accumulated event list. */
export const mergeEvents = (
  existing: StoredEvent[],
  incoming: StoredEvent[],
): StoredEvent[] => {
  const bySeq = new Map<number, StoredEvent>();
  for (const stored of existing) bySeq.set(stored.event_seq, stored);
  for (const stored of incoming) bySeq.set(stored.event_seq, stored);
  return [...bySeq.values()].sort((a, b) => a.event_seq - b.event_seq);
};

/** "model_request" vs "session:start" style tag for log rows and chips. */
export const eventTag = (event: StoredEvent["event"]): string =>
  "event" in event ? `${event.kind}:${event.event}` : event.kind;

/**
 * A session is running unless an end came after the latest start — listeners
 * re-attach with a fresh start after idle-timeout ends, so the last word wins.
 */
export const isEnded = (timeline: SessionTimeline): boolean => {
  const lastStart = timeline.starts.at(-1);
  const lastEnd = timeline.ends.at(-1);
  return (
    lastEnd !== undefined &&
    (lastStart === undefined || lastStart.occurred_at < lastEnd.occurred_at)
  );
};

/** One line of detail for the raw event log. */
export const describeEvent = (event: StoredEvent["event"]): string => {
  switch (event.kind) {
    case "session":
      if (event.event === "start")
        return [event.cwd, event.git_remote].filter(Boolean).join(" · ");
      if (event.event === "meta")
        return event.title ?? event.task_preview ?? "";
      if (event.event === "summary")
        return [
          event.model,
          event.usage
            ? `${event.usage.input_tokens ?? 0}in/${event.usage.output_tokens ?? 0}out`
            : "",
          event.body,
        ]
          .filter(Boolean)
          .join(" · ");
      return event.reason ?? "";
    case "turn":
      if (event.event === "start")
        return [
          event.user_message ?? event.turn_id,
          event.images ? `${event.images.length} image(s)` : "",
          event.files ? event.files.map((file) => file.name).join(", ") : "",
        ]
          .filter(Boolean)
          .join(" · ");
      return event.usage
        ? `${event.usage.input_tokens ?? 0}in/${event.usage.output_tokens ?? 0}out`
        : "";
    case "quarantine":
      return `quarantined · ${event.reason}`;
    // attachments live in their own table, never in the event log — but the
    // union still has to be handled here
    case "attachment":
      return `attachment · ${event.origin} · ${event.mime}`;
    case "model_request":
      return [
        `${event.provider}/${event.model}`,
        `${event.duration_ms}ms`,
        event.usage
          ? `${event.usage.input_tokens ?? 0}in/${event.usage.output_tokens ?? 0}out`
          : "",
        event.attempt && event.attempt > 1 ? `attempt ${event.attempt}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    case "tool":
      if (event.event === "call")
        return [event.tool, summarizeArgs(event.args)]
          .filter(Boolean)
          .join(" · ");
      return [
        event.tool,
        event.duration_ms !== undefined ? `${event.duration_ms}ms` : "",
        event.error ?? (event.ok === false ? "failed" : ""),
      ]
        .filter(Boolean)
        .join(" · ");
  }
};
