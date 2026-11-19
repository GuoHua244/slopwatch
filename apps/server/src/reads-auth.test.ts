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
    listSessions: async (teamId?: string, userId?: string) => {
      calls.push(`listSessions:${teamId ?? "-"}:${userId ?? "-"}`);
      return [];
    },
    eventsSince: async () => {
      calls.push("eventsSince");
      return [];
    },
    sessionOwner: async () => "alice",
    getAttachment: async () => null,
    deleteSession: async () => false,
    touchSession: async () => false,
    pruneRaw: async () => ({ archived: 0, pruned: 0 }),
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
    backfillTokenTotals: async () => 0,
    backfillResponseText: async () => 0,
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
    resolveAuthSession: async () => null,
    getPasswordAuth: async () => null,
    setPasswordHash: async () => false,
    clearPassword: async () => false,
    createAuthSession: async () => {
      throw new Error("not scripted");
    },
    revokeAuthSession: async () => false,
    revokeAllAuthSessions: async () => 0,
    resolveOidcUser: async () => null,
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
    deleteComment: async () => {
      calls.push("deleteComment");
      return false;
    },
    isDri: async () => false,
    setUserDri: async () => null,
    roleOf: async () => "member" as const,
    setUserRole: async () => null,
    ensureUser: async () => false,
    ensureAdmin: async () => {},
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
    createRetro: async () => {
      throw new Error("not scripted");
    },
    getRetro: async () => null,
    listRetros: async () => [],
    setRetroRunning: async () => {},
    setRetroProgress: async () => {},
    setRetroCompleted: async () => {},
    setRetroFailed: async () => {},
    failStaleRetros: async () => 0,
    hasOpenRetroFor: async () => false,
    allEvents: async () => [],
    rawForEvents: async () => [],
    childRollups: async () => [],
    getLlmConfig: async () => null,
    setLlmConfig: async () => {},
    clearLlmConfig: async () => {},
    addFeedback: async () => null,
    getFeedback: async () => null,
    listFeedback: async () => ({ rows: [], total: 0 }),
    deleteFeedback: async () => false,
    addFeedbackAttachments: async () => {},
    getFeedbackAttachment: async () => null,
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

  test("the team filter reaches the store verbatim; a member is self-scoped", async () => {
    const store = scriptedStore();
    const a = createApp({
      tokens: new Map([["tok-alice", "alice"]]),
      store,
    });
    // scriptedStore defaults to the member role: every read carries the
    // caller's own user_id alongside whatever team filter was requested.
    await get(a, "/sessions?team_id=team-1", "tok-alice");
    await get(a, "/sessions?team_id=unassigned", "tok-alice");
    await get(a, "/sessions", "tok-alice");
    expect(store.calls).toEqual([
      "listSessions:team-1:alice",
      "listSessions:unassigned:alice",
      "listSessions:-:alice",
    ]);
  });

  test("an admin reads org-wide: no self scoping on sessions or rollups", async () => {
    const store = scriptedStore();
    store.roleOf = async (name) => (name === "alice" ? "admin" : "member");
    const a = createApp({
      tokens: new Map([["tok-alice", "alice"]]),
      store,
    });
    expect((await get(a, "/sessions", "tok-alice")).status).toBe(200);
    expect((await get(a, "/rollups", "tok-alice")).status).toBe(200);
    expect(store.calls).toEqual(["listSessions:-:-", "listRollups"]);
  });

  test("a member's rollups are scoped to their own user_id", async () => {
    const store = scriptedStore();
    let seenUserId: string | undefined;
    store.listRollups = async (_day, _hour, _teamId, userId) => {
      seenUserId = userId;
      return {
        totals: [],
        model_totals: [],
        daily: [],
        user_hourly: [],
        model_daily: [],
        model_hourly: [],
      };
    };
    const a = createApp({
      tokens: new Map([["tok-alice", "alice"]]),
      store,
    });
    await get(a, "/rollups?days=7", "tok-alice");
    expect(seenUserId).toBe("alice");
  });

  test("a member reading someone else's session events gets a 404", async () => {
    const store = scriptedStore();
    // The session exists but belongs to bob.
    store.sessionOwner = async () => "bob";
    const a = createApp({
      tokens: new Map([["tok-alice", "alice"]]),
      store,
    });
    expect((await get(a, "/sessions/sess_x/events", "tok-alice")).status).toBe(
      404,
    );
    // ...and her own session reads fine.
    store.sessionOwner = async () => "alice";
    expect((await get(a, "/sessions/sess_x/events", "tok-alice")).status).toBe(
      200,
    );
  });

  test("an admin reads any session's events", async () => {
    const store = scriptedStore();
    store.roleOf = async () => "admin";
    // owner is someone else entirely — role wins
    store.sessionOwner = async () => "bob";
    const a = createApp({
      tokens: new Map([["tok-alice", "alice"]]),
      store,
    });
    expect((await get(a, "/sessions/sess_x/events", "tok-alice")).status).toBe(
      200,
    );
  });

  test("an IdP-issued bearer resolves through the OIDC verifier (ADR 0005)", async () => {
    const store = scriptedStore();
    store.resolveOidcUser = async (identity) =>
      identity.subject === "carol" ? "carol" : null;
    const a = createApp({
      tokens: new Map(),
      store,
      oidc: {
        verify: async (token) =>
          token === "oidc-jwt"
            ? {
                subject: "carol",
                email: null,
                preferredUsername: null,
                name: null,
              }
            : null,
      },
    });
    expect((await get(a, "/sessions", "oidc-jwt")).status).toBe(200);
    expect((await get(a, "/me", "oidc-jwt")).status).toBe(200);
    expect((await get(a, "/sessions", "not-the-token")).status).toBe(401);
  });

  test("minted tokens still win when the OIDC verifier is present", async () => {
    const store = scriptedStore();
    const a = createApp({
      tokens: new Map([["tok-alice", "alice"]]),
      store,
      oidc: { verify: async () => null },
    });
    expect((await get(a, "/sessions", "tok-alice")).status).toBe(200);
  });
});

describe("attachment route (captured image bytes)", () => {
  const sha = "a".repeat(64);
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  test("follows the read-plane gate: 401 anonymous, 404 foreign, 200 own", async () => {
    const store = scriptedStore();
    store.getAttachment = async () => ({ mime: "image/png", data: bytes });
    const a = createApp({
      tokens: new Map([["tok-alice", "alice"]]),
      store,
    });
    expect((await get(a, `/sessions/sess_x/attachments/${sha}`)).status).toBe(
      401,
    );
    // owner bob → 404 without touching the store (existence never leaks)
    store.sessionOwner = async () => "bob";
    let probed = false;
    const probe = store.getAttachment;
    store.getAttachment = async (...args) => {
      probed = true;
      return probe(...(args as [string, string]));
    };
    expect(
      (await get(a, `/sessions/sess_x/attachments/${sha}`, "tok-alice")).status,
    ).toBe(404);
    expect(probed).toBe(false);
    // her own session streams the bytes back
    store.sessionOwner = async () => "alice";
    const res = await get(
      a,
      `/sessions/sess_x/attachments/${sha}`,
      "tok-alice",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  test("an admin reads any session's images", async () => {
    const store = scriptedStore();
    store.roleOf = async () => "admin";
    store.sessionOwner = async () => "bob";
    store.getAttachment = async () => ({ mime: "image/png", data: bytes });
    const a = createApp({
      tokens: new Map([["tok-alice", "alice"]]),
      store,
    });
    expect(
      (await get(a, `/sessions/sess_x/attachments/${sha}`, "tok-alice")).status,
    ).toBe(200);
  });

  test("an unknown sha answers 404; a malformed one is not even routed", async () => {
    const store = scriptedStore();
    const a = createApp({
      tokens: new Map([["tok-alice", "alice"]]),
      store,
    });
    expect(
      (await get(a, `/sessions/sess_x/attachments/${sha}`, "tok-alice")).status,
    ).toBe(404);
    // 63 chars — off-spec ids fall through to the plain 404
    expect(
      (
        await get(
          a,
          `/sessions/sess_x/attachments/${"a".repeat(63)}`,
          "tok-alice",
        )
      ).status,
    ).toBe(404);
  });
});
