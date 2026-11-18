import { describe, expect, test } from "bun:test";
import { createApp, type App } from "../http";
import type { Store } from "../store";

// ADR 0011: the password sign-in plane at the http layer. The store is a
// script: credential rows and sessions are canned, hashing stays real
// (Bun.password), and assertions watch which store methods the routes call.
const scriptedStore = (): Store & { calls: string[] } => {
  const calls: string[] = [];
  const credentials = new Map<
    string,
    { passwordHash: string | null; disabled: boolean }
  >([["alice", { passwordHash: null, disabled: false }]]);
  let store: Store;
  const base = {
    migrate: async () => {},
    appendEvents: async () => ({ accepted: 0 }),
    listSessions: async () => [],
    eventsSince: async () => [],
    sessionOwner: async () => "alice",
    getAttachment: async () => null,
    deleteSession: async () => false,
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
    getUser: async (name: string) => {
      const row = credentials.get(name);
      return row
        ? {
            name,
            email: null,
            disabled: row.disabled,
            is_dri: false,
            role: (name === "admin-user" ? "admin" : "member") as
              | "admin"
              | "member",
            created_at: new Date().toISOString(),
            active_tokens: 0,
            password_set: row.passwordHash !== null,
            team_id: null,
            team_name: null,
          }
        : null;
    },
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
    teamsWithMembers: async () => [],
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
    getPasswordAuth: async (name: string) => credentials.get(name) ?? null,
    setPasswordHash: async (name: string, hash: string) => {
      calls.push(`setPasswordHash:${name}`);
      const row = credentials.get(name);
      if (!row) return false;
      row.passwordHash = hash;
      return true;
    },
    clearPassword: async (name: string) => {
      calls.push(`clearPassword:${name}`);
      const row = credentials.get(name);
      if (!row) return false;
      row.passwordHash = null;
      return true;
    },
    createAuthSession: async (userName: string) => {
      calls.push(`createAuthSession:${userName}`);
      return { token: `swsess_${crypto.randomUUID()}`, session_id: "s-1" };
    },
    resolveAuthSession: async (token: string) =>
      token === "sess-alice" ? "alice" : null,
    revokeAuthSession: async (token: string) => {
      calls.push(`revokeAuthSession:${token}`);
      return token === "sess-alice";
    },
    revokeAllAuthSessions: async (userName: string, exceptHash?: string) => {
      calls.push(
        `revokeAllAuthSessions:${userName}:${exceptHash === undefined ? "none" : exceptHash.slice(0, 8)}`,
      );
      return 0;
    },
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

const post = (a: App, path: string, body: unknown): Promise<Response> =>
  a.fetch(
    new Request(`http://x${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const put = (
  a: App,
  path: string,
  body: unknown,
  token?: string,
): Promise<Response> =>
  a.fetch(
    new Request(`http://x${path}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

const send = (a: App, method: string, path: string, token?: string) =>
  a.fetch(
    new Request(`http://x${path}`, {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  );

const loginOk = async (a: App, store: Store): Promise<{ token: string }> => {
  const res = await post(a, "/auth/login", {
    name: "alice",
    password: "correct horse battery",
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string };
};

describe("POST /auth/login (ADR 0011)", () => {
  test("a correct name and password mint a session bearer", async () => {
    const store = scriptedStore();
    await store.setPasswordHash(
      "alice",
      await Bun.password.hash("correct horse battery"),
    );
    const a = createApp({ tokens: new Map(), store });
    const res = await post(a, "/auth/login", {
      name: "alice",
      password: "correct horse battery",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: string };
    expect(body.user).toBe("alice");
    expect(body.token.startsWith("swsess_")).toBe(true);
    expect(store.calls).toContain("createAuthSession:alice");
  });

  test("an unknown name answers 401 invalid_credentials without creating a session", async () => {
    const store = scriptedStore();
    const a = createApp({ tokens: new Map(), store });
    const res = await post(a, "/auth/login", {
      name: "nobody",
      password: "whatever-password",
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_credentials",
    );
    expect(store.calls).not.toContain("createAuthSession:nobody");
  });

  test("a wrong password answers 401 invalid_credentials", async () => {
    const store = scriptedStore();
    await store.setPasswordHash(
      "alice",
      await Bun.password.hash("correct horse battery"),
    );
    const a = createApp({ tokens: new Map(), store });
    const res = await post(a, "/auth/login", {
      name: "alice",
      password: "wrong horse battery",
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_credentials",
    );
  });

  test("a user without a password names the fix, not a fake failure", async () => {
    const a = createApp({ tokens: new Map(), store: scriptedStore() });
    const res = await post(a, "/auth/login", {
      name: "alice",
      password: "some-password-8",
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; hint?: string };
    expect(body.error).toBe("password_not_set");
    expect(body.hint).toContain("token");
  });

  test("a disabled user is just another invalid credential", async () => {
    const store = scriptedStore();
    await store.setPasswordHash(
      "alice",
      await Bun.password.hash("correct horse battery"),
    );
    // The stub hands back the live row, so flipping the flag here is what a
    // disabled user's row would look like to the route.
    const row = (await store.getPasswordAuth("alice"))!;
    row.disabled = true;
    const a = createApp({ tokens: new Map(), store });
    const res = await post(a, "/auth/login", {
      name: "alice",
      password: "correct horse battery",
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_credentials",
    );
  });

  test("malformed bodies are 400 — no name or a short password", async () => {
    const a = createApp({ tokens: new Map(), store: scriptedStore() });
    expect((await post(a, "/auth/login", {})).status).toBe(400);
    expect((await post(a, "/auth/login", { name: "alice" })).status).toBe(400);
    expect(
      (await post(a, "/auth/login", { name: "alice", password: "short" }))
        .status,
    ).toBe(400);
  });

  test("too many failures lock the name out with a 429", async () => {
    const store = scriptedStore();
    // A password must exist so the attempts are wrong-password failures —
    // the password_not_set answer deliberately counts nothing.
    await store.setPasswordHash(
      "alice",
      await Bun.password.hash("correct horse battery"),
    );
    const a = createApp({
      tokens: new Map(),
      store,
      loginGuard: { max: 3, windowMs: 60_000, failDelayMs: 0 },
    });
    const wrong = { name: "alice", password: "wrong-password-9" };
    for (let i = 0; i < 3; i += 1)
      expect((await post(a, "/auth/login", wrong)).status).toBe(401);
    expect((await post(a, "/auth/login", wrong)).status).toBe(429);
    // Even the correct password stays locked out for the window.
    expect(
      (
        await post(a, "/auth/login", {
          name: "alice",
          password: "correct horse battery",
        })
      ).status,
    ).toBe(429);
  });

  test("a successful login resets the failure count", async () => {
    const store = scriptedStore();
    await store.setPasswordHash(
      "alice",
      await Bun.password.hash("correct horse battery"),
    );
    const a = createApp({
      tokens: new Map(),
      store,
      loginGuard: { max: 3, windowMs: 60_000, failDelayMs: 0 },
    });
    expect(
      (await post(a, "/auth/login", { name: "alice", password: "nope-99999" }))
        .status,
    ).toBe(401);
    expect(
      (
        await post(a, "/auth/login", {
          name: "alice",
          password: "correct horse battery",
        })
      ).status,
    ).toBe(200);
    // One more failure is tolerated again — the counter restarted.
    expect(
      (await post(a, "/auth/login", { name: "alice", password: "nope-99999" }))
        .status,
    ).toBe(401);
  });

  test("a login is audited with the user as the actor", async () => {
    const store = scriptedStore();
    await store.setPasswordHash(
      "alice",
      await Bun.password.hash("correct horse battery"),
    );
    const entries: { action: string; target: string }[] = [];
    store.appendAudit = async (entry) => {
      entries.push({ action: entry.action, target: entry.target });
    };
    const a = createApp({ tokens: new Map(), store });
    await post(a, "/auth/login", {
      name: "alice",
      password: "correct horse battery",
    });
    expect(entries).toEqual([{ action: "auth.login", target: "alice" }]);
  });
});

describe("session bearers ride the normal auth gate", () => {
  test("GET /me resolves a login-issued session token", async () => {
    const store = scriptedStore();
    await store.setPasswordHash(
      "alice",
      await Bun.password.hash("correct horse battery"),
    );
    const a = createApp({ tokens: new Map(), store });
    const { token } = await loginOk(a, store);
    store.resolveAuthSession = async (t) => (t === token ? "alice" : null);
    const res = await send(a, "GET", "/me", token);
    expect(res.status).toBe(200);
    const me = (await res.json()) as { user: string; password_set: boolean };
    expect(me.user).toBe("alice");
    expect(me.password_set).toBe(true);
  });

  test("GET /me reports password_set false while no password exists", async () => {
    const a = createApp({
      tokens: new Map([["tok-alice", "alice"]]),
      store: scriptedStore(),
    });
    const me = (await (await send(a, "GET", "/me", "tok-alice")).json()) as {
      password_set: boolean;
    };
    expect(me.password_set).toBe(false);
  });

  test("an unknown session token is still just 401", async () => {
    const a = createApp({ tokens: new Map(), store: scriptedStore() });
    expect((await send(a, "GET", "/me", "sess-garbage")).status).toBe(401);
  });
});

describe("POST /auth/logout", () => {
  test("revokes the bearer's session and answers 204", async () => {
    const store = scriptedStore();
    const a = createApp({ tokens: new Map(), store });
    const res = await send(a, "POST", "/auth/logout", "sess-alice");
    expect(res.status).toBe(204);
    expect(store.calls).toContain("revokeAuthSession:sess-alice");
  });

  test("an API-token bearer logs out as a harmless no-op — 204, session store consulted but no match", async () => {
    const store = scriptedStore();
    const a = createApp({ tokens: new Map(), store });
    const res = await send(a, "POST", "/auth/logout", "tok-alice");
    expect(res.status).toBe(204);
    expect(store.calls).toContain("revokeAuthSession:tok-alice");
  });
});

describe("PUT /me/password (ADR 0011)", () => {
  test("first-time set needs no current password", async () => {
    const store = scriptedStore();
    const a = createApp({ tokens: new Map([["tok-alice", "alice"]]), store });
    const res = await put(
      a,
      "/me/password",
      { new_password: "brand-new-pw" },
      "tok-alice",
    );
    expect(res.status).toBe(200);
    expect(store.calls).toContain("setPasswordHash:alice");
    // The stored value is an argon2 hash, never the plaintext.
    const row = (await store.getPasswordAuth("alice"))!;
    expect(row.passwordHash?.startsWith("$argon2id$")).toBe(true);
    expect(JSON.stringify(store.calls)).not.toContain("brand-new-pw");
    expect(
      store.calls.some((c) => c.startsWith("revokeAllAuthSessions:alice:")),
    ).toBe(true);
  });

  test("changing an existing password requires the current one", async () => {
    const store = scriptedStore();
    await store.setPasswordHash(
      "alice",
      await Bun.password.hash("current-password"),
    );
    const a = createApp({ tokens: new Map([["tok-alice", "alice"]]), store });
    const missing = await put(
      a,
      "/me/password",
      { new_password: "next-password" },
      "tok-alice",
    );
    expect(missing.status).toBe(400);
    const wrong = await put(
      a,
      "/me/password",
      { new_password: "next-password", current_password: "not-it" },
      "tok-alice",
    );
    expect(wrong.status).toBe(400);
    expect(
      (
        await put(
          a,
          "/me/password",
          {
            new_password: "next-password",
            current_password: "current-password",
          },
          "tok-alice",
        )
      ).status,
    ).toBe(200);
    expect(
      await Bun.password.verify(
        "next-password",
        (await store.getPasswordAuth("alice"))!.passwordHash!,
      ),
    ).toBe(true);
  });

  test("a too-short new password is 400 before any store write", async () => {
    const store = scriptedStore();
    const a = createApp({ tokens: new Map([["tok-alice", "alice"]]), store });
    expect(
      (await put(a, "/me/password", { new_password: "short" }, "tok-alice"))
        .status,
    ).toBe(400);
    expect(store.calls).toEqual([]);
  });

  test("anonymous requests are 401", async () => {
    const a = createApp({ tokens: new Map(), store: scriptedStore() });
    expect(
      (await put(a, "/me/password", { new_password: "long-enough-pw" })).status,
    ).toBe(401);
  });

  test("setting a password is audited; changing says change", async () => {
    const store = scriptedStore();
    const actions: string[] = [];
    store.appendAudit = async (entry) => {
      actions.push(entry.action);
    };
    const a = createApp({ tokens: new Map([["tok-alice", "alice"]]), store });
    await put(
      a,
      "/me/password",
      { new_password: "first-password" },
      "tok-alice",
    );
    await put(
      a,
      "/me/password",
      { new_password: "second-password", current_password: "first-password" },
      "tok-alice",
    );
    expect(actions).toEqual(["auth.password.set", "auth.password.change"]);
  });
});

describe("DELETE /admin/users/:name/password (ADR 0011)", () => {
  test("the operator bypass clears the password and every session", async () => {
    const store = scriptedStore();
    await store.setPasswordHash(
      "alice",
      await Bun.password.hash("gone-soon-1"),
    );
    const a = createApp({
      tokens: new Map(),
      store,
      adminToken: "op-token",
    });
    const res = await send(
      a,
      "DELETE",
      "/admin/users/alice/password",
      "op-token",
    );
    expect(res.status).toBe(200);
    expect(store.calls).toContain("clearPassword:alice");
    expect(store.calls).toContain("revokeAllAuthSessions:alice:none");
    expect((await store.getPasswordAuth("alice"))?.passwordHash).toBeNull();
  });

  test("an unknown user answers 404", async () => {
    const store = scriptedStore();
    const a = createApp({
      tokens: new Map(),
      store,
      adminToken: "op-token",
    });
    expect(
      (await send(a, "DELETE", "/admin/users/nobody/password", "op-token"))
        .status,
    ).toBe(404);
  });

  test("a signed-in admin passes; a member gets 403", async () => {
    const store = scriptedStore();
    store.roleOf = async (name) => (name === "admin-user" ? "admin" : "member");
    const a = createApp({
      tokens: new Map([["tok-admin", "admin-user"]]),
      store,
    });
    expect(
      (await send(a, "DELETE", "/admin/users/alice/password", "tok-admin"))
        .status,
    ).toBe(200);
    const memberApp = createApp({
      tokens: new Map([["tok-member", "alice"]]),
      store: scriptedStore(),
    });
    expect(
      (
        await send(
          memberApp,
          "DELETE",
          "/admin/users/alice/password",
          "tok-member",
        )
      ).status,
    ).toBe(403);
  });
});
