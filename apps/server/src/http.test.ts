import { describe, expect, test } from "bun:test";
import {
  SCHEMA_VERSION,
  type NormalEvent,
  type SessionStartEvent,
} from "@slopwatch/events";
import { createApp, type App } from "./http";
import type { Store } from "./store";

// Auth tests run everywhere with a throwing stub store — authentication must
// be checked before any storage access (resolveTokenUser participates in auth,
// so it answers null instead of throwing). The DB-backed tests below are
// skipped unless DATABASE_URL is set (CI has no Postgres yet).
const refusingStore = (): Store => ({
  migrate: () => {
    throw new Error("store must not be touched");
  },
  appendEvents: () => {
    throw new Error("store must not be touched");
  },
  listSessions: () => {
    throw new Error("store must not be touched");
  },
  eventsSince: () => {
    throw new Error("store must not be touched");
  },
  deleteSession: () => {
    throw new Error("store must not be touched");
  },
  getSetting: async () => null,
  setSetting: async () => {},
  clearSetting: async () => {},
  listSettings: async () => ({}),
  appendAudit: async () => {},
  listAudit: async () => ({ rows: [], total: 0 }),
  getSession: async () => null,
  getComment: async () => null,
  getTeam: async () => null,
  getToken: async () => null,
  pruneRaw: () => {
    throw new Error("store must not be touched");
  },
  backfillResponseText: () => {
    throw new Error("store must not be touched");
  },
  backfillTokenTotals: () => {
    throw new Error("store must not be touched");
  },
  listRollups: async () => ({
    totals: [],
    model_totals: [],
    daily: [],
    user_hourly: [],
    model_daily: [],
    model_hourly: [],
  }),
  backfillRollups: () => {
    throw new Error("store must not be touched");
  },
  createUser: () => {
    throw new Error("store must not be touched");
  },
  getUser: () => {
    throw new Error("store must not be touched");
  },
  listUsers: () => {
    throw new Error("store must not be touched");
  },
  setUserDisabled: () => {
    throw new Error("store must not be touched");
  },
  deleteUser: () => {
    throw new Error("store must not be touched");
  },
  mintToken: () => {
    throw new Error("store must not be touched");
  },
  listTokens: () => {
    throw new Error("store must not be touched");
  },
  revokeToken: () => {
    throw new Error("store must not be touched");
  },
  resolveTokenUser: async () => null,
  resolveOidcUser: async () => null,
  markReviewed: () => {
    throw new Error("store must not be touched");
  },
  unmarkReviewed: () => {
    throw new Error("store must not be touched");
  },
  reviewFor: async () => null,
  addComment: () => {
    throw new Error("store must not be touched");
  },
  listComments: async () => [],
  deleteComment: () => {
    throw new Error("store must not be touched");
  },
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
  health: () => {
    throw new Error("store must not be touched");
  },
  listQuarantine: async () => [],
  createTeam: () => {
    throw new Error("store must not be touched");
  },
  listTeams: () => {
    throw new Error("store must not be touched");
  },
  updateTeam: () => {
    throw new Error("store must not be touched");
  },
  deleteTeam: () => {
    throw new Error("store must not be touched");
  },
  setUserTeam: () => {
    throw new Error("store must not be touched");
  },
  teamsWithMembers: () => {
    throw new Error("store must not be touched");
  },
  close: async () => {},
});

const app = (): App =>
  createApp({
    tokens: new Map([["tok-alice", "alice"]]),
    store: refusingStore(),
  });

const post = (a: App, body: unknown, token?: string) =>
  a.fetch(
    new Request("http://x/events", {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(body),
    }),
  );

const sessionStart = (): SessionStartEvent => ({
  schema_version: SCHEMA_VERSION,
  agent: "zcode",
  session_id: "sess_test-1",
  occurred_at: new Date().toISOString(),
  kind: "session",
  event: "start",
  cwd: "D:\\demo",
  hostname: "DEV-01",
});

describe("auth", () => {
  test("401 without a token", async () => {
    const res = await post(app(), {
      schema_version: SCHEMA_VERSION,
      events: [sessionStart()],
    });
    expect(res.status).toBe(401);
  });

  test("401 with an unknown token", async () => {
    const res = await post(
      app(),
      { schema_version: SCHEMA_VERSION, events: [sessionStart()] },
      "tok-wrong",
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /events validation", () => {
  test("400 on wrong schema_version", async () => {
    const res = await post(
      app(),
      { schema_version: 99, events: [sessionStart()] },
      "tok-alice",
    );
    expect(res.status).toBe(400);
  });

  test("400 when any event fails isNormalEvent", async () => {
    const bad: NormalEvent = { ...sessionStart(), hostname: "" };
    const res = await post(
      app(),
      { schema_version: SCHEMA_VERSION, events: [sessionStart(), bad] },
      "tok-alice",
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /rollups", () => {
  test("answers with the snapshot shape and sane default windows", async () => {
    let seen: { sinceDay: string; sinceHour: string } | undefined;
    const spyStore: Store = {
      ...refusingStore(),
      listRollups: async (sinceDay, sinceHour) => {
        seen = { sinceDay, sinceHour };
        return {
          totals: [],
          model_totals: [],
          daily: [],
          model_daily: [],
          user_hourly: [],
          model_hourly: [],
        };
      },
    };
    // reads are token-gated since decision 22 — the request carries a token
    const res = await createApp({
      tokens: new Map([["tok-alice", "alice"]]),
      store: spyStore,
    }).fetch(
      new Request("http://x/rollups?days=99999&hours=not-a-number", {
        headers: { authorization: "Bearer tok-alice" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      totals: [],
      model_totals: [],
      daily: [],
      model_daily: [],
      user_hourly: [],
      model_hourly: [],
    });
    expect(seen).toBeDefined();
    expect(seen!.sinceDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(seen!.sinceHour).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}$/);
  });

  test("the team scope reaches the store verbatim, absent when unfiltered", async () => {
    const seen: (string | undefined)[] = [];
    const spyStore: Store = {
      ...refusingStore(),
      listRollups: async (_sinceDay, _sinceHour, teamId) => {
        seen.push(teamId);
        return {
          totals: [],
          model_totals: [],
          daily: [],
          model_daily: [],
          user_hourly: [],
          model_hourly: [],
        };
      },
    };
    const app = createApp({
      tokens: new Map([["tok-alice", "alice"]]),
      store: spyStore,
    });
    const auth = { headers: { authorization: "Bearer tok-alice" } };
    await app.fetch(new Request("http://x/rollups", auth));
    await app.fetch(new Request("http://x/rollups?team_id=team-1", auth));
    await app.fetch(new Request("http://x/rollups?team_id=unassigned", auth));
    expect(seen).toEqual([undefined, "team-1", "unassigned"]);
  });
});

// --- DB-backed integration tests (require DATABASE_URL) ---

const dbTests = () =>
  (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL) !== undefined;
const testDsn = () =>
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!;

describe.skipIf(!dbTests())("events endpoint against Postgres", () => {
  // created lazily in beforeAll so a missing DB surfaces as skipped, not crash
  let dbApp: App | undefined;
  let store: Store | undefined;

  test("append is monotonic per session and since_seq paginates", async () => {
    const { createPgStore } = await import("./store");
    store = createPgStore(testDsn());
    await store.migrate();
    dbApp = createApp({ tokens: new Map([["tok-alice", "alice"]]), store });

    // unique per run — the test database persists between runs
    const sessionId = `sess_httptest-${crypto.randomUUID().slice(0, 8)}`;
    const s1 = sessionStart();
    s1.session_id = sessionId;
    const res1 = await post(
      dbApp!,
      { schema_version: SCHEMA_VERSION, events: [s1] },
      "tok-alice",
    );
    expect(res1.status).toBe(202);
    const body1 = (await res1.json()) as { accepted: number };
    expect(body1.accepted).toBe(1);

    const second: NormalEvent = {
      ...s1,
      kind: "model_request",
      provider: "p",
      model: "m",
      duration_ms: 5,
      usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 10 },
      occurred_at: new Date().toISOString(),
    };
    const meta: NormalEvent = {
      ...s1,
      kind: "session",
      event: "meta",
      title: "介绍一下 slopwatch",
      task_preview: "Hi ZCode，给我介绍一下 slopwatch 吧",
      occurred_at: new Date().toISOString(),
    };
    const res2 = await post(
      dbApp!,
      { schema_version: SCHEMA_VERSION, events: [second, meta] },
      "tok-alice",
    );
    expect(res2.status).toBe(202);

    const since0 = await dbApp!.fetch(
      new Request(`http://x/sessions/${sessionId}/events`, {
        headers: { authorization: "Bearer tok-alice" },
      }),
    );
    expect(since0.status).toBe(200);
    const page0 = (await since0.json()) as {
      session_id: string;
      events: { event_seq: number; event: NormalEvent }[];
    };
    expect(page0.session_id).toBe(sessionId);
    expect(page0.events.map((e) => e.event_seq)).toEqual([1, 2, 3]);
    expect(page0.events[0]!.event.kind).toBe("session");
    expect(page0.events[1]!.event.kind).toBe("model_request");

    const since2 = await dbApp!.fetch(
      new Request(`http://x/sessions/${sessionId}/events?since_seq=1`, {
        headers: { authorization: "Bearer tok-alice" },
      }),
    );
    const page1 = (await since2.json()) as { events: { event_seq: number }[] };
    expect(page1.events.map((e) => e.event_seq)).toEqual([2, 3]);

    const sessions = await dbApp!.fetch(
      new Request("http://x/sessions", {
        headers: { authorization: "Bearer tok-alice" },
      }),
    );
    const list = (await sessions.json()) as {
      sessions: {
        session_id: string;
        last_seq: number;
        title: string | null;
        task_preview: string | null;
        total_input_tokens: number;
        total_output_tokens: number;
        total_cache_read_tokens: number;
      }[];
    };
    const row = list.sessions.find((s) => s.session_id === sessionId);
    expect(row?.last_seq).toBe(3);
    expect(row?.title).toBe("介绍一下 slopwatch");
    expect(row?.task_preview).toContain("介绍一下 slopwatch 吧");
    expect(row?.total_input_tokens).toBe(100);
    expect(row?.total_output_tokens).toBe(50);
    expect(row?.total_cache_read_tokens).toBe(10);
  });

  test("rollups reflect appended events", async () => {
    const res = await dbApp!.fetch(
      new Request("http://x/rollups?days=1&hours=1", {
        headers: { authorization: "Bearer tok-alice" },
      }),
    );
    expect(res.status).toBe(200);
    const snap = (await res.json()) as {
      model_daily: {
        user_id: string;
        model: string;
        model_requests: number;
      }[];
    };
    // The DB persists between runs, so alice's sums only ever grow.
    expect(
      snap.model_daily.find((r) => r.user_id === "alice" && r.model === "m")
        ?.model_requests,
    ).toBeGreaterThanOrEqual(1);
  });

  test("healthz", async () => {
    const res = await app().fetch(new Request("http://x/healthz"));
    expect(res.status).toBe(200);
  });

  test("cleanup", async () => {
    if (store) await store.close();
  });
});
