import { describe, expect, test } from "bun:test";
import { createApp, type App } from "./http";
import type { Store } from "./store";

// v2 decision 22 / ADR 0003: every data read requires a bearer token. The
// store answers empty-but-successful so a 200 proves the auth gate passed;
// a refusing stub proves the gate fires before any storage access.
const scriptedStore = (): Store & { calls: string[] } => {
  const calls: string[] = [];
  let store: Store;
  const base = {
    migrate: async () => {},
    appendEvents: async () => ({ accepted: 0 }),
    listSessions: async (teamId?: string) => {
      calls.push(
        teamId === undefined ? "listSessions" : `listSessions:${teamId}`,
      );
      return [];
    },
    eventsSince: async () => {
      calls.push("eventsSince");
      return [];
    },
    deleteSession: async () => false,
    pruneRaw: async () => ({ archived: 0, pruned: 0 }),
    getSetting: async () => null,
    setSetting: async () => {},
    clearSetting: async () => {},
    listSettings: async () => ({}),
    backfillTokenTotals: async () => 0,
    listRollups: async () => {
      calls.push("listRollups");
      return {
        totals: [],
        model_totals: [],
        daily: [],
        user_hourly: [],
        model_daily: [],
        model_hourly: [],
      };
    },
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
    markReviewed: async () => null,
    unmarkReviewed: async () => false,
    reviewFor: async () => {
      calls.push("reviewFor");
      return null;
    },
    addComment: async () => null,
    listComments: async () => {
      calls.push("listComments");
      return [];
    },
    isDri: async () => false,
    setUserDri: async () => null,
    health: async () => ({
      sessions: 0,
      events: 0,
      last_event_at: null,
      quarantine_total: 0,
      quarantine_24h: 0,
      last_quarantine_at: null,
    }),
    listQuarantine: async () => [],
    createTeam: async () => {
      throw new Error("not scripted");
    },
    listTeams: async () => [],
    updateTeam: async () => null,
    deleteTeam: async () => false,
    setUserTeam: async () => null,
    teamsWithMembers: async () => {
      calls.push("teamsWithMembers");
      return [];
    },
    close: async () => {},
  };
  store = base as Store;
  return Object.assign(store, { calls });
};

const app = (): App =>
  createApp({
    tokens: new Map([["tok-alice", "alice"]]),
    store: scriptedStore(),
  });

const get = (a: App, path: string, token?: string): Promise<Response> =>
  a.fetch(
    new Request(`http://x${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  );

describe("read-plane authentication (decision 22)", () => {
  const READS = [
    "/sessions",
    "/sessions/sess_x/events",
    "/rollups",
    "/teams",
    "/sessions/sess_x/review",
    "/sessions/sess_x/comments",
  ];

  for (const path of READS) {
    test(`anonymous GET ${path} is 401`, async () => {
      expect((await get(app(), path)).status).toBe(401);
    });
    test(`GET ${path} with a garbage token is 401`, async () => {
      expect((await get(app(), path, "tok-wrong")).status).toBe(401);
    });
    test(`GET ${path} with a valid token is 200`, async () => {
      expect((await get(app(), path, "tok-alice")).status).toBe(200);
    });
  }

  test("healthz stays anonymous — the ops probe", async () => {
    expect((await get(app(), "/healthz")).status).toBe(200);
  });

  test("POST /events still requires its own token", async () => {
    const a = app();
    const res = await a.fetch(
      new Request("http://x/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schema_version: 1, events: [] }),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("the team filter reaches the store verbatim", async () => {
    const store = scriptedStore();
    const a = createApp({
      tokens: new Map([["tok-alice", "alice"]]),
      store,
    });
    await get(a, "/sessions?team_id=team-1", "tok-alice");
    await get(a, "/sessions?team_id=unassigned", "tok-alice");
    await get(a, "/sessions", "tok-alice");
    expect(store.calls).toEqual([
      "listSessions:team-1",
      "listSessions:unassigned",
      "listSessions",
    ]);
  });
});
