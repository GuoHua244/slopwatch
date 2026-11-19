/**
 * v3 decision 37: the read-only MCP endpoint. Streamable HTTP transport —
 * POST /mcp carries one JSON-RPC request per call; a notification answers
 * 202, everything else answers JSON. Hand-rolled: the whole surface is three
 * methods (initialize, tools/list, tools/call) and every tool maps one-to-one
 * onto an existing read-plane query, so a second process or an SDK dependency
 * would out-weigh the protocol code. No write tools, no subscriptions, no
 * server-initiated pushes — the token's authority never widens beyond what
 * the dashboard already grants, and member scoping carries over verbatim
 * (members read only their own rows; admins read org-wide).
 */
import type { Reader } from "./http/auth";
import type { Store } from "./store";

/** The protocol dialects this server speaks; the client's version echoes
 * back when it is one of these, else the server's newest. */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
const SERVER_VERSION = "0.1.0";

type JsonSchema = {
  type: "object";
  properties: Record<string, { type: string; description: string }>;
  required?: string[];
};

type ToolDef = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

export const MCP_TOOLS: ToolDef[] = [
  {
    name: "get_session",
    description:
      "One coding-agent session's facts: agent, owner, title, token totals, waste counters (members see only their own sessions).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The session id." },
      },
      required: ["session_id"],
    },
  },
  {
    name: "list_recent_sessions",
    description:
      "The newest sessions the caller may read — org-wide for an admin, the caller's own for a member. Newest first, capped at 50.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "string",
          description: "How many rows to return (default 20, max 50).",
        },
      },
    },
  },
  {
    name: "list_session_events",
    description:
      "A session's captured events after a sequence number (turns, tool calls, model requests with token usage). 1000 events max per call.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The session id." },
        since_seq: {
          type: "string",
          description: "Return events after this event_seq (default 0).",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "list_session_commits",
    description:
      "The git commits a session's tool calls made — sha when the capture caught git's output, subject, branch.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The session id." },
      },
      required: ["session_id"],
    },
  },
  {
    name: "get_usage",
    description:
      "Per-developer usage rollups over a window: all-time totals plus daily turn/tool/waste counts and per-model token rows. A member receives only their own rows.",
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "string",
          description: "How many days the daily window covers (default 30).",
        },
      },
    },
  },
];

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
};

type JsonRpcResult = { status: number; body: unknown };

const ok = (id: unknown, result: unknown): JsonRpcResult => ({
  status: 200,
  body: { jsonrpc: "2.0", id, result },
});

const rpcError = (
  id: unknown,
  code: number,
  message: string,
): JsonRpcResult => ({
  status: 200,
  body: { jsonrpc: "2.0", id, error: { code, message } },
});

/** Member scoping verbatim from the read plane: a foreign or unknown session
 * answers "no such session" — existence never leaks across users. */
const readOwnSession = async (
  store: Store,
  reader: Reader,
  sessionId: string,
): Promise<string | null> => {
  if (reader.role !== "admin") {
    const owner = await store.sessionOwner(sessionId);
    if (owner !== reader.user) return "no such session";
  }
  return null;
};

const toolResult = (text: string, isError = false): JsonRpcResult["body"] => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

const callTool = async (
  store: Store,
  reader: Reader,
  name: string,
  args: Record<string, unknown>,
): Promise<JsonRpcResult["body"]> => {
  const str = (key: string): string | undefined => {
    const v = args[key];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
  };
  const num = (key: string): number | undefined => {
    const v = Number(args[key]);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
  };
  switch (name) {
    case "get_session": {
      const sessionId = str("session_id");
      if (sessionId === undefined)
        return toolResult("session_id is required", true);
      const denied = await readOwnSession(store, reader, sessionId);
      if (denied !== null) return toolResult(denied, true);
      const session = await store.getSession(sessionId);
      if (session === null) return toolResult("no such session", true);
      return toolResult(JSON.stringify(session, null, 2));
    }
    case "list_recent_sessions": {
      const limit = Math.min(num("limit") ?? 20, 50);
      const sessions = await store.listSessions(
        undefined,
        reader.role === "admin" ? undefined : reader.user,
      );
      return toolResult(JSON.stringify(sessions.slice(0, limit), null, 2));
    }
    case "list_session_events": {
      const sessionId = str("session_id");
      if (sessionId === undefined)
        return toolResult("session_id is required", true);
      const denied = await readOwnSession(store, reader, sessionId);
      if (denied !== null) return toolResult(denied, true);
      const sinceSeq = num("since_seq") ?? 0;
      const events = await store.eventsSince(sessionId, sinceSeq);
      return toolResult(JSON.stringify(events, null, 2));
    }
    case "list_session_commits": {
      const sessionId = str("session_id");
      if (sessionId === undefined)
        return toolResult("session_id is required", true);
      const denied = await readOwnSession(store, reader, sessionId);
      if (denied !== null) return toolResult(denied, true);
      const commits = await store.listSessionCommits(sessionId);
      return toolResult(JSON.stringify(commits, null, 2));
    }
    case "get_usage": {
      const days = Math.min(num("days") ?? 30, 3650);
      const sinceDay = new Date(Date.now() - (days - 1) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const snapshot = await store.listRollups(
        sinceDay,
        `${sinceDay}T00`,
        undefined,
        reader.role === "admin" ? undefined : reader.user,
      );
      return toolResult(JSON.stringify(snapshot, null, 2));
    }
    default:
      // Unreachable — tools/call rejects unknown names before dispatching.
      return toolResult(`unknown tool ${name}`, true);
  }
};

/**
 * Route one JSON-RPC request. A body that is not an object (or lacks a
 * method) answers the parse-error code; notifications (no id) answer 202
 * with no body, per the streamable-HTTP transport.
 */
export const handleMcp = async (
  store: Store,
  reader: Reader,
  request: unknown,
): Promise<JsonRpcResult> => {
  if (
    request === null ||
    typeof request !== "object" ||
    Array.isArray(request)
  ) {
    return rpcError(null, -32700, "parse error: expected a JSON-RPC object");
  }
  const { id, method, params } = request as JsonRpcRequest;
  if (typeof method !== "string") {
    return rpcError(id ?? null, -32600, "invalid request: method is required");
  }
  // A notification carries no id — acknowledge with 202, no body.
  if (id === undefined && method.startsWith("notifications/")) {
    return { status: 202, body: null };
  }
  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      const version =
        typeof requested === "string" &&
        (PROTOCOL_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : PROTOCOL_VERSIONS[0];
      return ok(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: {
          name: "slopwatch",
          title: "Slopwatch (read-only)",
          version: SERVER_VERSION,
        },
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: MCP_TOOLS });
    case "tools/call": {
      const name = params?.name;
      const toolArgs = params?.arguments;
      if (typeof name !== "string")
        return rpcError(id, -32602, "tools/call requires a tool name");
      if (!(MCP_TOOLS as { name: string }[]).some((t) => t.name === name))
        return rpcError(id, -32602, `unknown tool: ${name}`);
      return ok(
        id,
        await callTool(
          store,
          reader,
          name,
          toolArgs !== null &&
            typeof toolArgs === "object" &&
            !Array.isArray(toolArgs)
            ? (toolArgs as Record<string, unknown>)
            : {},
        ),
      );
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
};
