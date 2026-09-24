import { describe, expect, test } from "bun:test";
import { createApp, type App } from "./http";
import type { RetroRow, SessionRow, Store } from "./store";

const sessionRow = (): SessionRow => ({
  session_id: "s1",
  agent: "zcode",
  user_id: "alice",
  team_id: null,
  first_seen_at: "2026-09-25T00:00:00.000Z",
  last_event_at: "2026-09-25T01:00:00.000Z",
  last_seq: 10,
  title: "Fix the flaky test",
  task_preview: "make ci green",
  total_input_tokens: 100_000,
  total_output_tokens: 5_000,
  total_cache_read_tokens: 80_000,
  total_cache_write_tokens: 0,
});

// ADR 0008 route tests over a scripted store: scope follows the events
// route (member own-only, admin org-wide), a trigger needs the user's own
// LLM credentials and their single open run, and every trigger audits.
const scriptedStore = (overrides: Partial<Store> = {}) => {
  const audits: {
    action: string;
    target: string;
    detail?: Record<string, unknown>;
  }[] = [];
  const base = {
    migrate: async () => {},
    appendEvents: async () => ({ accepted: 0 }),
    listSessions: async () => [],
    eventsSince: async () => [],
    getAttachment: async () => null,
    deleteSession: async () => false,
    pruneRaw: async () => ({ archived: 0, pruned: 0 }),
    getSetting: async () => null,
    setSetting: async () => {},
    clearSetting: async () => {},
    listSettings: async () => ({}) as Record<string, string>,
    appendAudit: async (entry: {
      action: string;
      target: string;
      detail?: Record<string, unknown>;
    }) => {
      audits.push(entry);
    },
    listAudit: async () => ({ rows: [], total: 0 }),
    getSession: async () => null,
    getComment: async () => null,
    getTeam: async () => null,
    getToken: async () => null,
    backfillTokenTotals: async () => 0,
    backfillResponseText: async () => 0,
    listRollups: async () => ({
      totals: [],
      model_totals: [],
      daily: [],
      user_hourly: [],
      model_daily: [],
      model_hourly: [],
    }),
    backfillRollups: async () => 0,
    createUser: async () => {
      throw new Error("not scripted");
    },
    getUser: async () => null,
    listUsers: async () => [],
    setUserDisabled: async () => null,
    deleteUser: async () => false,
    mintToken: async () => {
      throw new Error("not scripted");
    },
    listTokens: async () => [],
    revokeToken: async () => false,
    resolveTokenUser: async () => null,
    resolveOidcUser: async () => null,
    markReviewed: async () => null,
    unmarkReviewed: async () => false,
    reviewFor: async () => null,
    addComment: async () => null,
    listComments: async () => [],
    deleteComment: async () => false,
    isDri: async () => false,
    setUserDri: async () => null,
    roleOf: async () => "member" as const,
    setUserRole: async () => null,
    ensureUser: async () => false,
    ensureAdmin: async () => {},
    sessionOwner: async () => null,
    ownUsage: async () => ({
      sessions: 0,
      first_seen_at: null,
      last_seen_at: null,
      turns: 0,
      tool_calls: 0,
      model_totals: [],
    }),
    health: async () => ({
      sessions: 0,
      events: 0,
      last_event_at: null,
      quarantine_total: 0,
      quarantine_24h: 0,
      last_quarantine_at: null,
    }),
    listQuarantine: async () => [],
    teamsWithMembers: async () => [],
    getLlmConfig: async () => null,
    setLlmConfig: async () => {},
    clearLlmConfig: async () => {},
    hasOpenRetroFor: async () => false,
    allEvents: async () => [],
    rawForEvents: async () => [],
    childRollups: async () => [],
    listRetros: async () => [] as RetroRow[],
    createRetro: (async () => {
      throw new Error("not scripted");
    }) as Store["createRetro"],
    getRetro: async () => null,
    setRetroRunning: async () => {},
    setRetroCompleted: async () => {},
    setRetroFailed: async () => {},
    failStaleRetros: async () => 0,
    ...overrides,
  };
  return {
    store: base as Store,
    audits,
  };
};

const appWith = (
  store: Store,
  tokens: Record<string, string>,
  retrospectives?: Parameters<typeof createApp>[0]["retrospectives"],
): App =>
  createApp({ tokens: new Map(Object.entries(tokens)), store, retrospectives });

const req = (
  app: App,
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<Response> =>
  app.fetch(
    new Request(`http://x${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }),
  );

const retroRow = (id: number): RetroRow => ({
  id,
  session_id: "s1",
  user_id: "alice",
  angle: "efficiency",
  supplement: null,
  system_snapshot: "sys",
  prompt_snapshot: "user prompt",
  status: "pending",
  result: null,
  model: null,
  input_tokens: null,
  output_tokens: null,
  cache_read_tokens: null,
  reasoning_tokens: null,
  error: null,
  created_at: "2026-09-25T00:00:00.000Z",
  started_at: null,
  finished_at: null,
});

describe("retrospective routes", () => {
  test("401 without a token — trigger and list both sit behind the read plane", async () => {
    const app = appWith(scriptedStore().store, {});
    expect((await req(app, "/sessions/s1/retrospectives")).status).toBe(401);
    expect(
      (await req(app, "/sessions/s1/retrospectives", { method: "POST" }))
        .status,
    ).toBe(401);
    expect((await req(app, "/retrospectives/angles")).status).toBe(401);
  });

  test("a member's foreign session answers 404 for GET and POST", async () => {
    const { store } = scriptedStore();
    const app = appWith(store, { tok: "alice" });
    expect(
      (await req(app, "/sessions/s1/retrospectives", {}, "tok")).status,
    ).toBe(404);
    expect(
      (
        await req(
          app,
          "/sessions/s1/retrospectives",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ angle: "efficiency" }),
          },
          "tok",
        )
      ).status,
    ).toBe(404);
  });

  test("POST without LLM credentials answers 409 with the fix", async () => {
    const { store } = scriptedStore({
      sessionOwner: async () => "alice",
      getSession: async () => sessionRow(),
    });
    const app = appWith(store, { tok: "alice" });
    const res = await req(
      app,
      "/sessions/s1/retrospectives",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ angle: "efficiency" }),
      },
      "tok",
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain(
      "profile page",
    );
  });

  test("POST with an open run answers 409 (one per user)", async () => {
    const { store } = scriptedStore({
      sessionOwner: async () => "alice",
      getSession: async () => sessionRow(),
      getLlmConfig: async () => ({
        endpoint: "http://llm/v1",
        model: "m",
        apiKey: "sk",
      }),
      hasOpenRetroFor: async () => true,
    });
    const app = appWith(store, { tok: "alice" });
    const res = await req(
      app,
      "/sessions/s1/retrospectives",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ angle: "efficiency" }),
      },
      "tok",
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain(
      "one at a time",
    );
  });

  test("unknown angle and custom-without-instruction both 400", async () => {
    const { store } = scriptedStore({
      sessionOwner: async () => "alice",
      getSession: async () => sessionRow(),
      getLlmConfig: async () => ({
        endpoint: "http://llm/v1",
        model: "m",
        apiKey: "sk",
      }),
    });
    const app = appWith(store, { tok: "alice" });
    const bad = await req(
      app,
      "/sessions/s1/retrospectives",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ angle: "nonsense" }),
      },
      "tok",
    );
    expect(bad.status).toBe(400);
    const custom = await req(
      app,
      "/sessions/s1/retrospectives",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ angle: "custom" }),
      },
      "tok",
    );
    expect(custom.status).toBe(400);
    expect(((await custom.json()) as { error: string }).error).toContain(
      "supplement",
    );
  });

  test("a valid trigger snapshots the prompts, enqueues, and returns the estimate", async () => {
    const created: Parameters<Store["createRetro"]>[0][] = [];
    const { store } = scriptedStore({
      sessionOwner: async () => "alice",
      getSession: async () => sessionRow(),
      getLlmConfig: async () => ({
        endpoint: "http://llm/v1",
        model: "m",
        apiKey: "sk-secret-abcd",
      }),
      allEvents: async () => [],
      createRetro: async (row) => {
        created.push(row);
        return retroRow(42);
      },
    });
    const enqueued: number[] = [];
    const app = appWith(
      store,
      { tok: "alice" },
      {
        enqueue: (id) => {
          enqueued.push(id);
        },
        size: () => 0,
      },
    );
    const res = await req(
      app,
      "/sessions/s1/retrospectives",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          angle: "efficiency",
          supplement: "重点看 token 浪费",
        }),
      },
      "tok",
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      retro: RetroRow;
      estimate: { input_tokens: number };
    };
    expect(body.retro.id).toBe(42);
    expect(body.retro.system_snapshot).toBeUndefined(); // snapshots stay server-side
    expect(body.estimate.input_tokens).toBeGreaterThan(0);
    expect(enqueued).toEqual([42]);
    expect(created).toHaveLength(1);
    expect(created[0]!.angle).toBe("efficiency");
    expect(created[0]!.promptSnapshot).toContain("重点看 token 浪费");
    expect(created[0]!.systemSnapshot).toContain("证据纪律");
  });

  test("triggering writes an audit_log entry", async () => {
    const scripted = scriptedStore({
      sessionOwner: async () => "alice",
      getSession: async () => sessionRow(),
      getLlmConfig: async () => ({
        endpoint: "http://llm/v1",
        model: "m",
        apiKey: "sk",
      }),
      createRetro: async (row) => ({ ...retroRow(9), angle: row.angle }),
    });
    const app = appWith(
      scripted.store,
      { tok: "alice" },
      { enqueue: () => {}, size: () => 0 },
    );
    await req(
      app,
      "/sessions/s1/retrospectives",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ angle: "efficiency" }),
      },
      "tok",
    );
    const entry = scripted.audits.at(-1);
    expect(entry?.action).toBe("retrospective.trigger");
    expect(entry?.target).toBe("s1");
    expect(entry?.detail).toMatchObject({ retro_id: 9, angle: "efficiency" });
  });

  test("GET /me masks the stored api key to a hint", async () => {
    const { store } = scriptedStore({
      getLlmConfig: async () => ({
        endpoint: "http://llm/v1",
        model: "glm-4.6",
        apiKey: "sk-verysecret-9z8y",
      }),
      getUser: async () => null,
    });
    const app = appWith(store, { tok: "alice" });
    const res = await req(app, "/me", {}, "tok");
    const me = (await res.json()) as { llm: { api_key_hint: string } };
    expect(me.llm.api_key_hint).toBe("••••9z8y");
    expect(JSON.stringify(me)).not.toContain("verysecret");
  });

  test("PUT /me/llm requires a key the first time, keeps it when blank, audits without the key", async () => {
    let stored: { endpoint: string; model: string; apiKey: string } | null =
      null;
    const scripted = scriptedStore({
      getLlmConfig: async () => stored,
      setLlmConfig: async (_name, config) => {
        stored = config;
      },
    });
    const app = appWith(scripted.store, { tok: "alice" });
    const noKey = await req(
      app,
      "/me/llm",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: "http://llm/v1", model: "m" }),
      },
      "tok",
    );
    expect(noKey.status).toBe(400);
    const first = await req(
      app,
      "/me/llm",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoint: "http://llm/v1",
          model: "m",
          api_key: "sk-first",
        }),
      },
      "tok",
    );
    expect(first.status).toBe(200);
    const update = await req(
      app,
      "/me/llm",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: "http://llm2/v1", model: "m2" }),
      },
      "tok",
    );
    expect(update.status).toBe(200);
    expect(stored!.apiKey).toBe("sk-first"); // blank field kept the original
    expect(stored!.endpoint).toBe("http://llm2/v1");
    expect(scripted.audits.some((a) => a.action === "llm.update")).toBe(true);
    expect(JSON.stringify(scripted.audits)).not.toContain("sk-first");
  });

  test("DELETE /me/llm clears the credentials", async () => {
    let cleared = false;
    const { store } = scriptedStore({
      clearLlmConfig: async () => {
        cleared = true;
      },
    });
    const app = appWith(store, { tok: "alice" });
    const res = await req(app, "/me/llm", { method: "DELETE" }, "tok");
    expect(res.status).toBe(204);
    expect(cleared).toBe(true);
  });

  test("GET /retrospectives/angles lists the presets plus the custom mode", async () => {
    const { store } = scriptedStore();
    const app = appWith(store, { tok: "alice" });
    const res = await req(app, "/retrospectives/angles", {}, "tok");
    const body = (await res.json()) as {
      angles: { id: string; title: string }[];
    };
    expect(res.status).toBe(200);
    expect(body.angles.map((a) => a.id)).toEqual([
      "efficiency",
      "session-hygiene",
      "tooling",
      "process",
      "prompting",
      "custom",
    ]);
  });

  test("without a runner the trigger answers 503 rather than silently dropping", async () => {
    const { store } = scriptedStore({
      sessionOwner: async () => "alice",
      getSession: async () => sessionRow(),
      getLlmConfig: async () => ({
        endpoint: "http://llm/v1",
        model: "m",
        apiKey: "sk",
      }),
    });
    const app = appWith(store, { tok: "alice" });
    const res = await req(
      app,
      "/sessions/s1/retrospectives",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ angle: "efficiency" }),
      },
      "tok",
    );
    expect(res.status).toBe(503);
  });
});
