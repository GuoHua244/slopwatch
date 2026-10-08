/**
 * Parsers for CodeBuddy's on-disk history: the per-conversation `index.json`
 * (a manifest rewritten wholesale on every step, NOT a line log) and the
 * one-file-per-message JSON payloads beside it.
 *
 * Everything here is pinned against a real Windows capture (2026-10-08,
 * agent version 4.12.1) — see research/codebuddy-capture-surfaces.md §2. The
 * shapes are undocumented, so each parser names exactly which fields it
 * needs and refuses loudly otherwise: silent loss under schema drift is what
 * the quarantine (v2 decision 21) exists to prevent.
 */
import type { NormalEvent } from "@slopwatch/events";

/** A row of the conversation manifest's `messages` array. */
export type IndexMessage = {
  id: string;
  type: string;
  role: string;
  isComplete: boolean;
};

/** A row of the manifest's `requests` array — one model-request group. */
export type IndexRequest = {
  id: string;
  type: string;
  messages: string[];
  state: string;
};

export type ConversationIndex = {
  messages: IndexMessage[];
  requests: IndexRequest[];
};

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asString = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

export const parseConversationIndex = (
  text: string,
): ParseResult<ConversationIndex> => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "index.json is not valid JSON" };
  }
  if (!isObject(raw))
    return { ok: false, reason: "index.json is not an object" };
  const rows = raw.messages;
  const requests = raw.requests;
  if (!Array.isArray(rows))
    return { ok: false, reason: "index.json has no messages array" };
  const messages: IndexMessage[] = [];
  for (const row of rows) {
    if (!isObject(row)) continue;
    const id = asString(row.id);
    if (!id) continue; // without an id the message file cannot be addressed
    messages.push({
      id,
      type: asString(row.type) ?? "unknown",
      role: asString(row.role) ?? "unknown",
      isComplete: row.isComplete === true,
    });
  }
  const parsed: IndexRequest[] = [];
  if (Array.isArray(requests)) {
    for (const row of requests) {
      if (!isObject(row)) continue;
      const id = asString(row.id);
      if (!id) continue;
      parsed.push({
        id,
        type: asString(row.type) ?? "unknown",
        messages: Array.isArray(row.messages)
          ? row.messages.filter((m): m is string => typeof m === "string")
          : [],
        state: asString(row.state) ?? "unknown",
      });
    }
  }
  return { ok: true, value: { messages, requests: parsed } };
};

/**
 * Manifest rows past the watermark — the history grows by appending rows, so
 * a positional watermark is both cheap and respawn-safe (drift would reorder,
 * never insert behind the cursor).
 */
export const newIndexMessages = (
  index: ConversationIndex,
  processed: number,
): IndexMessage[] => index.messages.slice(Math.max(processed, 0));

export type ToolCallBlock = {
  toolCallId: string;
  toolName: string;
  args?: unknown;
};

export type ToolResultBlock = {
  toolCallId: string;
  toolName: string;
  result: unknown;
};

/** One entry of `extra.toolStatus` — a tool run's state and its result. */
export type ToolRun = {
  ready?: boolean;
  status?: string;
  args?: unknown;
  result?: unknown;
  pendingConfirmation?: boolean;
};

export type CapturedMessage = {
  id: string;
  /** One of `user` | `assistant` | `tool` — the only three observed. */
  role: string;
  createdAt: string;
  /** Assistant/user prose: the concatenation of `text` blocks. */
  text: string;
  /** `reasoning` blocks, kept apart from speech (never counted as prose). */
  reasoning: string;
  toolCalls: ToolCallBlock[];
  toolResults: ToolResultBlock[];
  /** Results CodeBuddy inlines into the assistant message itself. */
  toolStatus: Record<string, ToolRun>;
  requestId: string | null;
  modelId: string | null;
  modelName: string | null;
  traceId: string | null;
  isHelperMessage: boolean;
};

/** Read failures carry a reason so the caller can quarantine the file verbatim. */
export type MessageParse =
  | { ok: true; message: CapturedMessage }
  | { ok: false; reason: string };

const textOf = (blocks: Record<string, unknown>[], type: string): string => {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type !== type) continue;
    const text = block.text;
    if (typeof text === "string") parts.push(text);
  }
  return parts.join("\n");
};

/**
 * Parse one `messages/<id>.json`. `message` and `extra` are double-encoded
 * (JSON strings inside the JSON file) — both are required shapes, and their
 * absence is drift, not emptiness.
 */
export const parseMessageFile = (text: string): MessageParse => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "message file is not valid JSON" };
  }
  if (!isObject(raw))
    return { ok: false, reason: "message file is not an object" };
  const id = asString(raw.id);
  const role = asString(raw.role);
  if (!id) return { ok: false, reason: "message file has no id" };
  if (!role) return { ok: false, reason: `message ${id} has no role` };

  let inner: unknown = null;
  if (typeof raw.message === "string") {
    try {
      inner = JSON.parse(raw.message);
    } catch {
      inner = null;
    }
  }
  const blocks: Record<string, unknown>[] =
    isObject(inner) && Array.isArray(inner.content)
      ? inner.content.filter(isObject)
      : [];

  const toolCalls: ToolCallBlock[] = [];
  const toolResults: ToolResultBlock[] = [];
  for (const block of blocks) {
    if (block.type === "tool-call") {
      const toolCallId = asString(block.toolCallId);
      const toolName = asString(block.toolName);
      if (toolCallId && toolName)
        toolCalls.push({ toolCallId, toolName, args: block.args });
    } else if (block.type === "tool-result") {
      const toolCallId = asString(block.toolCallId);
      const toolName = asString(block.toolName);
      if (toolCallId && toolName)
        toolResults.push({ toolCallId, toolName, result: block.result });
    }
  }

  const toolStatus: Record<string, ToolRun> = {};
  let extra: Record<string, unknown> = {};
  if (typeof raw.extra === "string") {
    try {
      const parsed: unknown = JSON.parse(raw.extra);
      if (isObject(parsed)) extra = parsed;
    } catch {
      extra = {};
    }
  }
  if (isObject(extra.toolStatus)) {
    for (const [key, run] of Object.entries(extra.toolStatus)) {
      if (isObject(run)) {
        toolStatus[key] = {
          ready: typeof run.ready === "boolean" ? run.ready : undefined,
          status: asString(run.status) ?? undefined,
          args: run.args,
          result: run.result,
          pendingConfirmation:
            typeof run.pendingConfirmation === "boolean"
              ? run.pendingConfirmation
              : undefined,
        };
      }
    }
  }

  const createdAt = asString(raw.createdAt) ?? new Date().toISOString();

  return {
    ok: true,
    message: {
      id,
      role,
      createdAt,
      text: textOf(blocks, "text"),
      reasoning: textOf(blocks, "reasoning"),
      toolCalls,
      toolResults,
      toolStatus,
      requestId: asString(extra.requestId),
      modelId: asString(extra.modelId),
      modelName: asString(extra.modelName),
      traceId: asString(extra.traceId),
      isHelperMessage: extra.isHelperMessage === true,
    },
  };
};

export type WorkspaceConversation = {
  id: string;
  name: string | null;
  createdAt: string | null;
  lastMessageAt: string | null;
};

export type WorkspaceIndex = {
  conversations: WorkspaceConversation[];
  current: string | null;
};

/**
 * `<root>/history/<ws-hash>/index.json` — the conversation list. Its `name`
 * field is the session's first user message, which is the only title this
 * agent offers (there is no ai-title record like Claude Code's).
 */
export const parseWorkspaceIndex = (text: string): WorkspaceIndex | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw) || !Array.isArray(raw.conversations)) return null;
  const conversations: WorkspaceConversation[] = [];
  for (const row of raw.conversations) {
    if (!isObject(row)) continue;
    const id = asString(row.id);
    if (!id) continue;
    conversations.push({
      id,
      name: asString(row.name),
      createdAt: asString(row.createdAt),
      lastMessageAt: asString(row.lastMessageAt),
    });
  }
  return { conversations, current: asString(raw.current) };
};

export const conversationTitle = (
  index: WorkspaceIndex | null,
  conversationId: string,
): string | null => {
  if (!index) return null;
  const hit = index.conversations.find((c) => c.id === conversationId);
  return hit?.name ?? null;
};

/** `isModelRequest` marker events in a batch — used by the capture engine. */
export const modelRequestsIn = (events: NormalEvent[]): NormalEvent[] =>
  events.filter((e) => e.kind === "model_request");
