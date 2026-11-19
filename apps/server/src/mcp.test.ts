import { describe, expect, test } from "bun:test";
import { createApp, type App } from "./http";
import { handleMcp } from "./mcp";
import type { Reader } from "./http/auth";

const member: Reader = { user: "alice", role: "member" };
const admin: Reader = { user: "admin", role: "admin" };

describe("MCP protocol (v3 decision 37)", () => {
  test("initialize echoes a supported protocol version and advertises tools", async () => {
    const res = await handleMcp({} as never, member, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      result: {
        protocolVersion: string;
        capabilities: { tools: unknown };
        serverInfo: { name: string };
      };
    };
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.serverInfo.name).toBe("slopwatch");
  });

  test("an unsupported version falls back to the server's newest", async () => {
    const res = await handleMcp({} as never, member, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect(
      (res.body as { result: { protocolVersion: string } }).result
        .protocolVersion,
    ).toBe("2025-06-18");
  });

  test("tools/list carries the read-only toolset with schemas", async () => {
    const res = await handleMcp({} as never, member, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const tools = (
      res.body as {
        result: { tools: { name: string; inputSchema: unknown }[] };
      }
    ).result.tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_session",
      "get_usage",
      "list_recent_sessions",
      "list_session_commits",
      "list_session_events",
    ]);
    for (const tool of tools) expect(tool.inputSchema).toBeDefined();
  });

  test("unknown tools and methods answer JSON-RPC errors", async () => {
    const unknownTool = await handleMcp({} as never, member, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "delete_everything", arguments: {} },
    });
    expect((unknownTool.body as { error: { code: number } }).error.code).toBe(
      -32602,
    );
    const unknownMethod = await handleMcp({} as never, member, {
      jsonrpc: "2.0",
      id: 4,
      method: "resources/list",
    });
    expect((unknownMethod.body as { error: { code: number } }).error.code).toBe(
      -32601,
    );
  });

  test("notifications answer 202 with no body", async () => {
    const res = await handleMcp({} as never, member, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(res.status).toBe(202);
    expect(res.body).toBeNull();
  });
});

// --- Postgres-backed: member scoping carries over verbatim ---

const dbTests = () =>
  (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL) !== undefined;
const testDsn = () =>
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!;

const sessionStart = (
  sessionId: string,
  occurredAt: string,
): import("@slopwatch/events").SessionStartEvent => ({
  schema_version: 1,
  agent: "codex",
  session_id: sessionId,
  occurred_at: occurredAt,
  kind: "session",
  event: "start",
  cwd: "D:\\demo",
  hostname: "DEV-01",
});

describe.skipIf(!dbTests())("MCP tools against Postgres", () => {
  let store: import("./store").Store | undefined;
  let app: App | undefined;
  const ensure = async () => {
    if (store) return;
    const { createPgStore } = await import("./store");
    store = createPgStore(testDsn());
    await store.migrate();
    for (const name of ["alice", "bob", "admin"]) {
      // Idempotent across runs — the test database persists.
      if ((await store.getUser(name)) === null)
        await store.createUser(name, null);
    }
    await store.ensureAdmin("admin");
    app = createApp({
      tokens: new Map([
        ["tok-alice", "alice"],
        ["tok-bob", "bob"],
        ["tok-admin", "admin"],
      ]),
      store,
    });
    // One session per member, seeded once for every test in this block.
    const seed = async (user: string, sessionId: string) => {
      const events: import("@slopwatch/events").NormalEvent[] = [
        sessionStart(sessionId, "2026-11-19T09:00:00Z"),
        {
          schema_version: 1,
          agent: "codex",
          session_id: sessionId,
          occurred_at: "2026-11-19T09:01:00Z",
          kind: "turn",
          event: "start",
          turn_id: "t1",
        },
        {
          schema_version: 1,
          agent: "codex",
          session_id: sessionId,
          occurred_at: "2026-11-19T09:02:00Z",
          kind: "model_request",
          provider: "p",
          model: "m1",
          duration_ms: 5,
          usage: { input_tokens: 500, output_tokens: 100 },
        },
      ];
      await store!.appendEvents(events, user);
    };
    await seed("alice", `sess_mcp-alice-${crypto.randomUUID().slice(0, 8)}`);
    await seed("bob", `sess_mcp-bob-${crypto.randomUUID().slice(0, 8)}`);
  };

  const rpc = async (
    token: string,
    method: string,
    params?: Record<string, unknown>,
    id = 1,
  ) => {
    const res = await app!.fetch(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }),
    );
    return {
      status: res.status,
      body:
        res.status === 202
          ? null
          : ((await res.json()) as Record<string, unknown>),
    };
  };

  const call = async (
    token: string,
    name: string,
    args: Record<string, unknown> = {},
  ) => {
    const res = await rpc(token, "tools/call", { name, arguments: args }, 9);
    const body = res.body as {
      result?: { content: { text: string }[]; isError?: boolean };
      error?: { message: string };
    };
    if (body.error !== undefined)
      return { text: body.error.message, isError: true };
    return {
      text: body.result?.content[0]?.text ?? "",
      isError: body.result?.isError === true,
    };
  };

  test("401 without a token; initialize works over the route with one", async () => {
    await ensure();
    const anon = await app!.fetch(
      new Request("http://x/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      }),
    );
    expect(anon.status).toBe(401);
    const handshake = await rpc("tok-alice", "initialize");
    expect(handshake.status).toBe(200);
    expect(
      (handshake.body as { result: { serverInfo: { name: string } } }).result
        .serverInfo.name,
    ).toBe("slopwatch");
  });

  test("a member sees only their own sessions; an admin sees both", async () => {
    await ensure();
    const aliceList = await call("tok-alice", "list_recent_sessions");
    const aliceSessions = JSON.parse(aliceList.text) as {
      session_id: string;
      user_id: string | null;
    }[];
    expect(aliceSessions.length).toBeGreaterThan(0);
    for (const s of aliceSessions) expect(s.user_id).toBe("alice");

    const adminList = await call("tok-admin", "list_recent_sessions");
    const adminSessions = JSON.parse(adminList.text) as {
      user_id: string | null;
    }[];
    const owners = new Set(adminSessions.map((s) => s.user_id));
    expect(owners.has("alice")).toBe(true);
    expect(owners.has("bob")).toBe(true);
  });

  test("a foreign session answers 'no such session', not its contents", async () => {
    await ensure();
    const bobList = await call("tok-bob", "list_recent_sessions");
    const bobSession = (
      JSON.parse(bobList.text) as { session_id: string }[]
    )[0]!.session_id;
    const foreign = await call("tok-alice", "get_session", {
      session_id: bobSession,
    });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toBe("no such session");
    // The admin role reads org-wide.
    const asAdmin = await call("tok-admin", "get_session", {
      session_id: bobSession,
    });
    expect(asAdmin.isError).toBe(false);
    expect(JSON.parse(asAdmin.text)).toMatchObject({
      session_id: bobSession,
      user_id: "bob",
    });
  });

  test("get_session, events, and commits read the caller's own session", async () => {
    await ensure();
    const aliceList = await call("tok-alice", "list_recent_sessions");
    const sessionId = (
      JSON.parse(aliceList.text) as { session_id: string }[]
    )[0]!.session_id;
    const session = await call("tok-alice", "get_session", {
      session_id: sessionId,
    });
    expect(JSON.parse(session.text)).toMatchObject({ agent: "codex" });
    const events = await call("tok-alice", "list_session_events", {
      session_id: sessionId,
    });
    const parsed = JSON.parse(events.text) as { event: { kind: string } }[];
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.some((e) => e.event.kind === "model_request")).toBe(true);
    const commits = await call("tok-alice", "list_session_commits", {
      session_id: sessionId,
    });
    expect(JSON.parse(commits.text)).toEqual([]);
  });

  test("get_usage is member-scoped: alice's rows only", async () => {
    await ensure();
    const usage = await call("tok-alice", "get_usage", { days: "7" });
    const snapshot = JSON.parse(usage.text) as {
      totals: { user_id: string }[];
    };
    for (const row of snapshot.totals) expect(row.user_id).toBe("alice");
    const adminUsage = await call("tok-admin", "get_usage", { days: "7" });
    const adminSnapshot = JSON.parse(adminUsage.text) as {
      totals: { user_id: string }[];
    };
    const owners = new Set(adminSnapshot.totals.map((r) => r.user_id));
    expect(owners.has("alice")).toBe(true);
    expect(owners.has("bob")).toBe(true);
  });

  test("cleanup", async () => {
    if (store) await store.close();
  });
});
