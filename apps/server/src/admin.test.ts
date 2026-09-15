import { describe, expect, test } from "bun:test";
import { createApp, type App } from "./http";
import {
  hashToken,
  NoSuchTeamError,
  TeamExistsError,
  UserExistsError,
  type AdminTokenRow,
  type AdminUserRow,
  type Store,
  type StoredEvent,
} from "./store";

/**
 * Route-level admin tests run everywhere against an in-memory store that
 * mirrors the Postgres semantics (unique names, cascade on delete, disabled
 * users and revoked tokens fail resolution). A DB-backed suite below proves
 * the real SQL does the same.
 */
const memStore = () => {
  const users = new Map<
    string,
    {
      email: string | null;
      disabled: boolean;
      is_dri: boolean;
      role: "admin" | "member";
      created_at: string;
      team_id?: string | null;
      team_name?: string | null;
    }
  >();
  const tokens = new Map<
    string,
    {
      hash: string;
      hint: string;
      user: string;
      created_at: string;
      revoked_at: string | null;
    }
  >();
  let sessions = 0;
  let events = 0;
  const teams = new Map<
    string,
    {
      name: string;
      raw_retention_days: number | null;
      created_at: string;
    }
  >();
  const seenSessions = new Set<string>();
  const sessionEvents = new Map<string, number>();
  const owners = new Map<string, string | null>();
  const row = (name: string): AdminUserRow => ({
    name,
    email: users.get(name)!.email,
    disabled: users.get(name)!.disabled,
    is_dri: users.get(name)!.is_dri,
    role: users.get(name)!.role,
    created_at: users.get(name)!.created_at,
    active_tokens: [...tokens.values()].filter(
      (t) => t.user === name && t.revoked_at === null,
    ).length,
    team_id: users.get(name)!.team_id ?? null,
    team_name: users.get(name)!.team_name ?? null,
  });
  const store: Store = {
    migrate: async () => {},
    appendEvents: async (events_: unknown[], userId) => {
      for (const e of events_ as { session_id: string }[]) {
        if (!seenSessions.has(e.session_id)) {
          seenSessions.add(e.session_id);
          owners.set(e.session_id, userId ?? null);
          sessions += 1;
        }
        events += 1;
        sessionEvents.set(
          e.session_id,
          (sessionEvents.get(e.session_id) ?? 0) + 1,
        );
      }
      return { accepted: (events_ as unknown[]).length };
    },
    deleteSession: async (sessionId) => {
      if (!seenSessions.has(sessionId)) return false;
      seenSessions.delete(sessionId);
      events -= sessionEvents.get(sessionId) ?? 0;
      sessionEvents.delete(sessionId);
      sessions -= 1;
      return true;
    },
    listSessions: async () => [],
    eventsSince: async (): Promise<StoredEvent[]> => [],
    pruneRaw: async () => ({ archived: 0, pruned: 0 }),
    getSetting: async () => null,
    setSetting: async () => {},
    clearSetting: async () => {},
    listSettings: async () => ({}),
    backfillTokenTotals: async () => 0,
    backfillResponseText: async () => 0,
    listRollups: async () => ({
      totals: [],
      model_totals: [],
      daily: [],
      model_daily: [],
      user_hourly: [],
      model_hourly: [],
    }),
    backfillRollups: async () => 0,
    createUser: async (name, email) => {
      if (users.has(name)) throw new UserExistsError(name);
      users.set(name, {
        email,
        disabled: false,
        is_dri: false,
        role: "member",
        created_at: new Date().toISOString(),
        team_id: null,
        team_name: null,
      });
      return row(name);
    },
    getUser: async (name) => (users.has(name) ? row(name) : null),
    listUsers: async () => [...users.keys()].map(row),
    setUserDisabled: async (name, disabled) => {
      if (!users.has(name)) return null;
      users.get(name)!.disabled = disabled;
      return row(name);
    },
    setUserDri: async (name, isDri) => {
      if (!users.has(name)) return null;
      users.get(name)!.is_dri = isDri;
      return row(name);
    },
    roleOf: async (name) => users.get(name)?.role ?? "member",
    setUserRole: async (name, role) => {
      if (!users.has(name)) return null;
      users.get(name)!.role = role;
      return row(name);
    },
    ensureUser: async (name) => {
      if (!users.has(name))
        users.set(name, {
          email: null,
          disabled: false,
          is_dri: false,
          role: "member",
          created_at: new Date().toISOString(),
          team_id: null,
          team_name: null,
        });
    },
    ensureAdmin: async (name) => {
      if (!users.has(name))
        users.set(name, {
          email: null,
          disabled: false,
          is_dri: false,
          role: "admin",
          created_at: new Date().toISOString(),
          team_id: null,
          team_name: null,
        });
      else users.get(name)!.role = "admin";
    },
    sessionOwner: async (sessionId) =>
      seenSessions.has(sessionId) ? (owners.get(sessionId) ?? null) : null,
    ownUsage: async (name) => {
      let owned = 0;
      for (const user of owners.values()) if (user === name) owned += 1;
      return {
        sessions: owned,
        first_seen_at: null,
        last_seen_at: null,
        turns: 0,
        tool_calls: 0,
        model_totals: [],
      };
    },
    setUserTeam: async (name, teamId) => {
      if (!users.has(name)) return null;
      const team = teamId === null ? null : teams.get(teamId);
      if (teamId !== null && !team) throw new NoSuchTeamError();
      users.get(name)!.team_id = teamId;
      users.get(name)!.team_name = team?.name ?? null;
      return row(name);
    },
    createTeam: async (name2, rawRetentionDays) => {
      if ([...teams.values()].some((t) => t.name === name2))
        throw new TeamExistsError(name2);
      const id = crypto.randomUUID();
      teams.set(id, {
        name: name2,
        raw_retention_days: rawRetentionDays,
        created_at: new Date().toISOString(),
      });
      return {
        id,
        name: name2,
        raw_retention_days: rawRetentionDays,
        created_at: teams.get(id)!.created_at,
        member_count: 0,
      };
    },
    listTeams: async () =>
      [...teams.entries()].map(([id, t]) => ({
        ...t,
        id,
        member_count: [...users.values()].filter((u) => u.team_id === id)
          .length,
      })),
    updateTeam: async (id, patch) => {
      const t = teams.get(id);
      if (!t) return null;
      if (patch.name !== undefined) t.name = patch.name;
      if (patch.raw_retention_days !== undefined)
        t.raw_retention_days = patch.raw_retention_days;
      return {
        ...t,
        id,
        member_count: [...users.values()].filter((u) => u.team_id === id)
          .length,
      };
    },
    deleteTeam: async (id) => teams.delete(id),
    teamsWithMembers: async () =>
      [...teams.entries()].map(([id, t]) => ({
        id,
        name: t.name,
        members: [...users.entries()]
          .filter(([, u]) => u.team_id === id)
          .map(([n]) => n),
      })),
    deleteUser: async (name) => {
      if (!users.has(name)) return false;
      users.delete(name);
      for (const [id, t] of tokens) if (t.user === name) tokens.delete(id);
      return true;
    },
    mintToken: async (userName) => {
      const token = `sw_${crypto.randomUUID().replaceAll("-", "")}`;
      const token_id = crypto.randomUUID();
      tokens.set(token_id, {
        hash: hashToken(token),
        hint: token.slice(0, 10),
        user: userName,
        created_at: new Date().toISOString(),
        revoked_at: null,
      });
      return { token_id, hint: token.slice(0, 10), token };
    },
    listTokens: async (userName): Promise<AdminTokenRow[]> =>
      [...tokens.entries()]
        .filter(([, t]) => t.user === userName)
        .map(([token_id, t]) => ({
          token_id,
          hint: t.hint,
          created_at: t.created_at,
          revoked_at: t.revoked_at,
        })),
    revokeToken: async (tokenId) => {
      const t = tokens.get(tokenId);
      if (!t || t.revoked_at !== null) return false;
      t.revoked_at = new Date().toISOString();
      return true;
    },
    resolveTokenUser: async (token) => {
      const hash = hashToken(token);
      for (const [id, t] of tokens) {
        if (t.hash !== hash) continue;
        if (t.revoked_at !== null) return null;
        if (users.get(t.user)?.disabled) return null;
        void id;
        return t.user;
      }
      return null;
    },
    resolveOidcUser: async () => null,
    markReviewed: async () => null,
    unmarkReviewed: async () => false,
    reviewFor: async () => null,
    addComment: async () => null,
    listComments: async () => [],
    deleteComment: async () => false,
    isDri: async () => false,
    health: async () => ({
      sessions,
      events,
      last_event_at: events > 0 ? new Date().toISOString() : null,
      quarantine_total: 0,
      quarantine_24h: 0,
      last_quarantine_at: null,
    }),
    listQuarantine: async () => [],
    close: async () => {},
  };
  return { store, tokens, users };
};

const appWith = (opts: {
  adminToken?: string;
  store: Store;
  archive?: { getObject(key: string): Promise<string> };
  defaultRawTtlDays?: number;
}): App => createApp({ tokens: new Map(), ...opts });

const admin = (
  a: App,
  method: string,
  path: string,
  body?: unknown,
  token = "admin-tok",
) =>
  a.fetch(
    new Request(`http://x${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );

describe("admin plane auth", () => {
  test("401 without a bearer token", async () => {
    const res = await admin(
      appWith({ adminToken: "admin-tok", store: memStore().store }),
      "GET",
      "/admin/users",
      undefined,
      "",
    );
    expect(res.status).toBe(401);
  });

  test("401 with the wrong token", async () => {
    const res = await admin(
      appWith({ adminToken: "admin-tok", store: memStore().store }),
      "GET",
      "/admin/users",
      undefined,
      "nope",
    );
    expect(res.status).toBe(401);
  });

  test("403 for a signed-in member — the plane is role-gated now", async () => {
    const { store } = memStore();
    await store.createUser("member-sam", null);
    const minted = await store.mintToken("member-sam");
    const res = await admin(
      appWith({ adminToken: "admin-tok", store }),
      "GET",
      "/admin/users",
      undefined,
      minted.token,
    );
    expect(res.status).toBe(403);
  });

  test("200 for an admin-role user token — no operator token configured", async () => {
    const { store } = memStore();
    await store.createUser("root", null);
    await store.setUserRole("root", "admin");
    const minted = await store.mintToken("root");
    const res = await admin(
      appWith({ store }),
      "GET",
      "/admin/users",
      undefined,
      minted.token,
    );
    expect(res.status).toBe(200);
  });

  test("the operator bypass still works alongside role admins", async () => {
    const res = await admin(
      appWith({ adminToken: "admin-tok", store: memStore().store }),
      "GET",
      "/admin/users",
    );
    expect(res.status).toBe(200);
  });
});

describe("admin user CRUD over the in-memory store", () => {
  const { store } = memStore();
  const app = appWith({ adminToken: "admin-tok", store });

  test("create → duplicate → list", async () => {
    const created = await admin(app, "POST", "/admin/users", {
      name: "bob",
      email: "bob@corp.dev",
    });
    expect(created.status).toBe(201);
    const { user } = (await created.json()) as { user: AdminUserRow };
    expect(user.name).toBe("bob");
    expect(user.disabled).toBe(false);
    expect(user.active_tokens).toBe(0);

    const dup = await admin(app, "POST", "/admin/users", { name: "bob" });
    expect(dup.status).toBe(409);

    const list = await admin(app, "GET", "/admin/users");
    const { users } = (await list.json()) as { users: AdminUserRow[] };
    expect(users.map((u) => u.name)).toContain("bob");
  });

  test("400 on an invalid body", async () => {
    expect(
      (await admin(app, "POST", "/admin/users", { name: "" })).status,
    ).toBe(400);
    expect((await admin(app, "POST", "/admin/users", {})).status).toBe(400);
    expect(
      (await admin(app, "POST", "/admin/users", "not-json" as never)).status,
    ).toBe(400);
  });

  test("disable and re-enable", async () => {
    await admin(app, "POST", "/admin/users", { name: "carol" });
    const off = await admin(app, "PATCH", "/admin/users/carol", {
      disabled: true,
    });
    const { user } = (await off.json()) as { user: AdminUserRow };
    expect(user.disabled).toBe(true);

    const on = await admin(app, "PATCH", "/admin/users/carol", {
      disabled: false,
    });
    expect(((await on.json()) as { user: AdminUserRow }).user.disabled).toBe(
      false,
    );
  });

  test("PATCH unknown user → 404, DELETE unknown → 404", async () => {
    expect(
      (await admin(app, "PATCH", "/admin/users/nobody", { disabled: true }))
        .status,
    ).toBe(404);
    expect((await admin(app, "DELETE", "/admin/users/nobody")).status).toBe(
      404,
    );
  });

  test("role changes: promote, demote, garbage, and the self-guard", async () => {
    await admin(app, "POST", "/admin/users", { name: "pri" });
    const up = await admin(app, "PATCH", "/admin/users/pri", {
      role: "admin",
    });
    expect(((await up.json()) as { user: AdminUserRow }).user.role).toBe(
      "admin",
    );

    const down = await admin(app, "PATCH", "/admin/users/pri", {
      role: "member",
    });
    expect(((await down.json()) as { user: AdminUserRow }).user.role).toBe(
      "member",
    );

    expect(
      (await admin(app, "PATCH", "/admin/users/pri", { role: "root" })).status,
    ).toBe(400);

    // The caller here is the operator bypass (no user identity), so the
    // self-guard must not fire on a same-named user.
    await admin(app, "POST", "/admin/users", { name: "admin-tok" });
    expect(
      (await admin(app, "PATCH", "/admin/users/admin-tok", { role: "member" }))
        .status,
    ).toBe(200);
  });

  test("an admin-role caller cannot demote themselves", async () => {
    const { store } = memStore();
    await store.createUser("boss", null);
    await store.setUserRole("boss", "admin");
    const minted = await store.mintToken("boss");
    const app = appWith({ adminToken: "admin-tok", store });
    const res = await admin(
      app,
      "PATCH",
      "/admin/users/boss",
      {
        role: "member",
      },
      minted.token,
    );
    expect(res.status).toBe(400);
    // someone else's role is still theirs to change
    await store.createUser("peer", null);
    await store.setUserRole("peer", "admin");
    const ok = await admin(
      app,
      "PATCH",
      "/admin/users/peer",
      {
        role: "member",
      },
      minted.token,
    );
    expect(ok.status).toBe(200);
  });

  test("delete removes the user and cascades token resolution", async () => {
    await admin(app, "POST", "/admin/users", { name: "dave" });
    const minted = (await (
      await admin(app, "POST", "/admin/users/dave/tokens")
    ).json()) as { token: string; token_id: string };
    expect(await store.resolveTokenUser(minted.token)).toBe("dave");

    expect((await admin(app, "DELETE", "/admin/users/dave")).status).toBe(200);
    expect(await store.resolveTokenUser(minted.token)).toBeNull();
    expect((await admin(app, "GET", "/admin/users/dave/tokens")).status).toBe(
      404,
    );
  });
});

describe("admin token lifecycle", () => {
  const { store } = memStore();
  const app = appWith({ adminToken: "admin-tok", store });

  test("mint → resolve → revoke → resolve fails (decision 6)", async () => {
    await admin(app, "POST", "/admin/users", { name: "erin" });
    const res = await admin(app, "POST", "/admin/users/erin/tokens");
    expect(res.status).toBe(201);
    const minted = (await res.json()) as {
      token: string;
      token_id: string;
      hint: string;
    };
    expect(minted.token.startsWith("sw_")).toBe(true);
    expect(await store.resolveTokenUser(minted.token)).toBe("erin");

    const list = (await (
      await admin(app, "GET", "/admin/users/erin/tokens")
    ).json()) as { tokens: AdminTokenRow[] };
    expect(list.tokens).toHaveLength(1);
    expect(list.tokens[0]!.hint).toBe(minted.hint);
    expect(list.tokens[0]!.revoked_at).toBeNull();

    expect(
      (await admin(app, "DELETE", `/admin/tokens/${minted.token_id}`)).status,
    ).toBe(200);
    expect(await store.resolveTokenUser(minted.token)).toBeNull();
    expect(
      (await admin(app, "DELETE", `/admin/tokens/${minted.token_id}`)).status,
    ).toBe(404);
  });

  test("mint for an unknown user → 404", async () => {
    expect((await admin(app, "POST", "/admin/users/ghost/tokens")).status).toBe(
      404,
    );
  });

  test("disabling a user kills its tokens immediately (decision 13)", async () => {
    await admin(app, "POST", "/admin/users", { name: "frank" });
    const minted = (await (
      await admin(app, "POST", "/admin/users/frank/tokens")
    ).json()) as { token: string };
    expect(await store.resolveTokenUser(minted.token)).toBe("frank");
    await admin(app, "PATCH", "/admin/users/frank", { disabled: true });
    expect(await store.resolveTokenUser(minted.token)).toBeNull();
  });
});

describe("admin endpoints integrate with ingestion", () => {
  test("a minted token POSTs events like an env token", async () => {
    const { store } = memStore();
    const app = appWith({ adminToken: "admin-tok", store });
    await admin(app, "POST", "/admin/users", { name: "gina" });
    const minted = (await (
      await admin(app, "POST", "/admin/users/gina/tokens")
    ).json()) as { token: string };

    const { SCHEMA_VERSION } = await import("@slopwatch/events");
    const res = await app.fetch(
      new Request("http://x/events", {
        method: "POST",
        headers: {
          authorization: `Bearer ${minted.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schema_version: SCHEMA_VERSION,
          events: [
            {
              schema_version: SCHEMA_VERSION,
              agent: "zcode",
              session_id: "sess_admin-e2e",
              occurred_at: new Date().toISOString(),
              kind: "session",
              event: "start",
              cwd: "D:\\demo",
              hostname: "DEV-01",
            },
          ],
        }),
      }),
    );
    expect(res.status).toBe(202);
    const health = (await (
      await admin(app, "GET", "/admin/health")
    ).json()) as { ok: boolean; sessions: number; events: number };
    expect(health.ok).toBe(true);
    expect(health.sessions).toBe(1);
    expect(health.events).toBe(1);
  });
});

describe("admin session deletion (decision 13)", () => {
  test("DELETE /admin/sessions/:id removes session and its events", async () => {
    const { store } = memStore();
    const app = createApp({
      tokens: new Map([["env-tok", "alice"]]),
      store,
      adminToken: "admin-tok",
    });
    const { SCHEMA_VERSION } = await import("@slopwatch/events");
    const post = (sessionId: string) =>
      app.fetch(
        new Request("http://x/events", {
          method: "POST",
          headers: {
            authorization: "Bearer env-tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            schema_version: SCHEMA_VERSION,
            events: [
              {
                schema_version: SCHEMA_VERSION,
                agent: "zcode",
                session_id: sessionId,
                occurred_at: new Date().toISOString(),
                kind: "session",
                event: "start",
                cwd: "D:\\demo",
                hostname: "DEV-01",
              },
            ],
          }),
        }),
      );
    // one keeper session and one leak session
    expect((await post("sess_keeper")).status).toBe(202);
    expect((await post("sess_leak")).status).toBe(202);
    expect((await store.health()).sessions).toBe(2);
    expect((await store.health()).events).toBe(2);

    expect(
      (await admin(app, "DELETE", "/admin/sessions/sess_leak")).status,
    ).toBe(200);
    expect((await store.health()).sessions).toBe(1);
    expect((await store.health()).events).toBe(1);
    expect(
      (await admin(app, "DELETE", "/admin/sessions/sess_leak")).status,
    ).toBe(404);
  });
});

describe("operator settings (decision 25)", () => {
  const settings = new Map<string, string>();
  const { store } = memStore();
  const settingsStore: Store = {
    ...store,
    getSetting: async (key) => settings.get(key) ?? null,
    setSetting: async (key, value) => void settings.set(key, value),
    clearSetting: async (key) => void settings.delete(key),
    listSettings: async () => Object.fromEntries(settings),
  };
  const app = appWith({ adminToken: "admin-tok", store: settingsStore });

  test("PUT sets a url; an explicit null clears it", async () => {
    const put = await admin(app, "PUT", "/admin/settings", {
      webhook_url: "https://hooks.example.com/x",
    });
    expect(put.status).toBe(200);
    expect(
      ((await put.json()) as { settings: Record<string, string> }).settings
        .webhook_url,
    ).toBe("https://hooks.example.com/x");

    const cleared = await admin(app, "PUT", "/admin/settings", {
      webhook_url: null,
    });
    expect(cleared.status).toBe(200);
    // Settings answer with effective values: a cleared URL reads back empty,
    // not missing.
    expect(
      ((await cleared.json()) as { settings: Record<string, string> }).settings
        .webhook_url,
    ).toBe("");
  });

  test("invalid values still 400", async () => {
    expect(
      (await admin(app, "PUT", "/admin/settings", { webhook_url: "ftp://x" }))
        .status,
    ).toBe(400);
    expect(
      (await admin(app, "PUT", "/admin/settings", { nope: "x" })).status,
    ).toBe(400);
  });

  test("raw_ttl_days accepts a positive integer, rejects the rest", async () => {
    expect(
      (await admin(app, "PUT", "/admin/settings", { raw_ttl_days: 30 })).status,
    ).toBe(200);
    expect(
      (await admin(app, "PUT", "/admin/settings", { raw_ttl_days: "45" }))
        .status,
    ).toBe(200);
    expect(
      (await admin(app, "PUT", "/admin/settings", { raw_ttl_days: 0 })).status,
    ).toBe(400);
    expect(
      (await admin(app, "PUT", "/admin/settings", { raw_ttl_days: -3 })).status,
    ).toBe(400);
    expect(
      (await admin(app, "PUT", "/admin/settings", { raw_ttl_days: "ten" }))
        .status,
    ).toBe(400);
    // null clears the override, and the effective value falls back to the
    // boot default the app was configured with.
    const cleared = await admin(app, "PUT", "/admin/settings", {
      raw_ttl_days: null,
    });
    expect(cleared.status).toBe(200);
    expect(
      ((await cleared.json()) as { settings: Record<string, string> }).settings
        .raw_ttl_days,
    ).toBe("90");
  });

  test("GET answers effective values even with nothing stored", async () => {
    const fresh = appWith({
      adminToken: "admin-tok",
      store: memStore().store,
      defaultRawTtlDays: 45,
    });
    const res = await admin(fresh, "GET", "/admin/settings");
    expect(res.status).toBe(200);
    expect(
      (await res.json()) as Record<string, Record<string, string>>,
    ).toEqual({
      settings: {
        webhook_url: "",
        webhook_enabled: "true",
        webhook_format: "slack",
        raw_ttl_days: "45",
      },
    });
  });
});

describe("admin archive retrieval (decision 21)", () => {
  const appWithArchive = (archive?: {
    getObject(key: string): Promise<string>;
  }) => appWith({ adminToken: "admin-tok", store: memStore().store, archive });

  const get = (a: App, path: string) => admin(a, "GET", path);

  test("fetches an archived payload by key", async () => {
    const app = appWithArchive({
      getObject: async (key) => `{"blob":"payload","key":"${key}"}`,
    });
    const res = await get(app, "/admin/archive?key=raw/zcode/sess_ok/7.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()) as Record<string, string>).toEqual({
      blob: "payload",
      key: "raw/zcode/sess_ok/7.json",
    });
  });

  test("400 on a key outside the server's namespace", async () => {
    const app = appWithArchive({
      getObject: async () => "{}",
    });
    for (const bad of [
      "/admin/archive?key=../secret",
      "/admin/archive?key=other/zcode/sess_x/1.json",
      "/admin/archive?key=raw/zcode/sess_x/not-a-seq.json",
      "/admin/archive",
    ]) {
      expect((await get(app, bad)).status).toBe(400);
    }
  });

  test("502 when the store misses, 400 when unconfigured", async () => {
    const app = appWithArchive({
      getObject: async () => {
        throw new Error("NoSuchKey");
      },
    });
    const res = await get(app, "/admin/archive?key=raw/zcode/sess_gone/1.json");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain(
      "NoSuchKey",
    );

    expect(
      (
        await get(
          appWithArchive(),
          "/admin/archive?key=raw/zcode/sess_x/1.json",
        )
      ).status,
    ).toBe(400);
  });
});

// --- DB-backed tests (require DATABASE_URL_TEST / DATABASE_URL) ---

const dbTests = () =>
  (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL) !== undefined;
const testDsn = () =>
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!;

describe.skipIf(!dbTests())("admin store semantics against Postgres", () => {
  let store: Store | undefined;
  const ensure = async () => {
    if (store) return;
    const { createPgStore } = await import("./store");
    store = createPgStore(testDsn());
    await store.migrate();
  };

  test("mint, resolve, disable, revoke, delete cascade", async () => {
    await ensure();
    const name = `admin-pg-${crypto.randomUUID().slice(0, 8)}`;
    const created = await store!.createUser(name, null);
    expect(created.active_tokens).toBe(0);

    const minted = await store!.mintToken(name);
    expect(minted.token.startsWith("sw_")).toBe(true);
    expect(await store!.resolveTokenUser(minted.token)).toBe(name);

    await store!.setUserDisabled(name, true);
    expect(await store!.resolveTokenUser(minted.token)).toBeNull();
    await store!.setUserDisabled(name, false);
    expect(await store!.resolveTokenUser(minted.token)).toBe(name);

    expect(await store!.revokeToken(minted.token_id)).toBe(true);
    expect(await store!.revokeToken(minted.token_id)).toBe(false);
    expect(await store!.resolveTokenUser(minted.token)).toBeNull();

    const second = await store!.mintToken(name);
    const tokens = await store!.listTokens(name);
    expect(tokens.map((t) => t.token_id)).toContain(second.token_id);
    expect(await store!.deleteUser(name)).toBe(true);
    expect(await store!.resolveTokenUser(second.token)).toBeNull();
    expect(await store!.getUser(name)).toBeNull();
  });

  test("duplicate user names are rejected", async () => {
    await ensure();
    const name = `admin-pg-dup-${crypto.randomUUID().slice(0, 8)}`;
    await store!.createUser(name, null);
    expect(store!.createUser(name, null)).rejects.toBeInstanceOf(
      UserExistsError,
    );
  });

  test("roles: default member, promote, self-scope reads, ensureUser/Admin", async () => {
    await ensure();
    const name = `admin-pg-role-${crypto.randomUUID().slice(0, 8)}`;
    await store!.createUser(name, null);
    expect(await store!.roleOf(name)).toBe("member");
    expect(await store!.roleOf("never-existed")).toBe("member");

    const promoted = await store!.setUserRole(name, "admin");
    expect(promoted?.role).toBe("admin");
    expect(await store!.roleOf(name)).toBe("admin");
    await store!.setUserRole(name, "member");
    expect(await store!.roleOf(name)).toBe("member");

    // ensureUser provisions without clobbering; ensureAdmin grants the role
    await store!.ensureUser(name);
    expect(await store!.roleOf(name)).toBe("member");
    const stranger = `admin-pg-stranger-${crypto.randomUUID().slice(0, 8)}`;
    await store!.ensureAdmin(stranger);
    expect(await store!.roleOf(stranger)).toBe("admin");

    // member-scoped reads: sessions are filtered by owner
    const { SCHEMA_VERSION } = await import("@slopwatch/events");
    const sessionId = `sess_role-${crypto.randomUUID().slice(0, 8)}`;
    await store!.appendEvents(
      [
        {
          schema_version: SCHEMA_VERSION,
          agent: "zcode",
          session_id: sessionId,
          occurred_at: new Date().toISOString(),
          kind: "session",
          event: "start",
          cwd: "D:\\demo",
          hostname: "DEV-01",
        },
      ] as never,
      name,
    );
    const mine = await store!.listSessions(undefined, name);
    expect(mine.some((s) => s.session_id === sessionId)).toBe(true);
    const others = await store!.listSessions(undefined, "somebody-else");
    expect(others.some((s) => s.session_id === sessionId)).toBe(false);
    expect(await store!.sessionOwner(sessionId)).toBe(name);
    expect(await store!.sessionOwner("sess_absent")).toBeNull();

    // the /me usage block answers the owner's own numbers
    const usage = await store!.ownUsage(name);
    expect(usage.sessions).toBe(1);
    expect(usage.first_seen_at).not.toBeNull();

    await store!.deleteUser(name);
    await store!.deleteUser(stranger);
  });

  test("health reports sessions and events counts", async () => {
    await ensure();
    const health = await store!.health();
    expect(Number.isInteger(health.sessions)).toBe(true);
    expect(Number.isInteger(health.events)).toBe(true);
  });

  test("deleteSession removes the session row and its events", async () => {
    await ensure();
    const { SCHEMA_VERSION } = await import("@slopwatch/events");
    const sessionId = `sess_admin-del-${crypto.randomUUID().slice(0, 8)}`;
    await store!.appendEvents(
      [
        {
          schema_version: SCHEMA_VERSION,
          agent: "zcode",
          session_id: sessionId,
          occurred_at: new Date().toISOString(),
          kind: "session",
          event: "start",
          cwd: "D:\\demo",
          hostname: "DEV-01",
        },
        {
          schema_version: SCHEMA_VERSION,
          agent: "zcode",
          session_id: sessionId,
          occurred_at: new Date().toISOString(),
          kind: "turn",
          event: "start",
          turn_id: "t1",
        },
      ] as never,
      "alice",
    );
    expect(
      (await store!.listSessions()).some((s) => s.session_id === sessionId),
    ).toBe(true);
    expect((await store!.eventsSince(sessionId, 0)).length).toBe(2);

    expect(await store!.deleteSession(sessionId)).toBe(true);
    expect(await store!.deleteSession(sessionId)).toBe(false);
    expect(
      (await store!.listSessions()).some((s) => s.session_id === sessionId),
    ).toBe(false);
    expect((await store!.eventsSince(sessionId, 0)).length).toBe(0);
  });

  test("cleanup", async () => {
    if (store) await store.close();
  });
});

describe("admin team plane (decision 23)", () => {
  const { store } = memStore();
  const app = createApp({
    tokens: new Map([["tok-alice", "alice"]]),
    adminToken: "admin-tok",
    store,
  });
  const alice = (method: string, path: string, body?: unknown) =>
    app.fetch(
      new Request(`http://x${path}`, {
        method,
        headers: {
          authorization: "Bearer tok-alice",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );

  test("create → duplicate → list → rename → retention → delete", async () => {
    const created = await admin(app, "POST", "/admin/teams", {
      name: "platform",
      raw_retention_days: 30,
    });
    expect(created.status).toBe(201);
    const { team } = (await created.json()) as {
      team: { id: string; name: string; raw_retention_days: number | null };
    };
    expect(team.name).toBe("platform");
    expect(team.raw_retention_days).toBe(30);

    expect(
      (await admin(app, "POST", "/admin/teams", { name: "platform" })).status,
    ).toBe(409);
    expect(
      (await admin(app, "POST", "/admin/teams", { name: "" })).status,
    ).toBe(400);
    expect(
      (
        await admin(app, "POST", "/admin/teams", {
          name: "bad",
          raw_retention_days: 0,
        })
      ).status,
    ).toBe(400);

    const list = await admin(app, "GET", "/admin/teams");
    expect(
      ((await list.json()) as { teams: { name: string }[] }).teams.some(
        (t) => t.name === "platform",
      ),
    ).toBe(true);

    const renamed = await admin(app, "PATCH", `/admin/teams/${team.id}`, {
      name: "infra",
      raw_retention_days: null,
    });
    const renamedTeam = (
      (await renamed.json()) as {
        team: { name: string; raw_retention_days: number | null };
      }
    ).team;
    expect(renamedTeam.name).toBe("infra");
    expect(renamedTeam.raw_retention_days).toBeNull();

    expect(
      (await admin(app, "PATCH", "/admin/teams/no-such-id", { name: "x" }))
        .status,
    ).toBe(404);
    expect((await admin(app, "DELETE", "/admin/teams/no-such-id")).status).toBe(
      404,
    );
    expect((await admin(app, "DELETE", `/admin/teams/${team.id}`)).status).toBe(
      200,
    );
  });

  test("assign a user via PATCH team_id; unknown team 404", async () => {
    await admin(app, "POST", "/admin/users", { name: "teamy" });
    const { team } = (await (
      await admin(app, "POST", "/admin/teams", { name: "web" })
    ).json()) as { team: { id: string } };

    const patched = await admin(app, "PATCH", "/admin/users/teamy", {
      team_id: team.id,
    });
    const { user } = (await patched.json()) as {
      user: { team_id: string; team_name: string };
    };
    expect(user.team_id).toBe(team.id);
    expect(user.team_name).toBe("web");

    const off = await admin(app, "PATCH", "/admin/users/teamy", {
      team_id: null,
    });
    expect(
      ((await off.json()) as { user: { team_id: null } }).user.team_id,
    ).toBe(null);

    expect(
      (
        await admin(app, "PATCH", "/admin/users/teamy", {
          team_id: "00000000-0000-0000-0000-000000000000",
        })
      ).status,
    ).toBe(404);
  });

  test("GET /teams is authenticated and returns the roster", async () => {
    await admin(app, "POST", "/admin/teams", { name: "roster-team" });
    expect((await alice("GET", "/teams")).status).toBe(200);
    expect((await app.fetch(new Request("http://x/teams"))).status).toBe(401);
    const adminTeams = await admin(app, "GET", "/admin/teams");
    expect(
      ((await adminTeams.json()) as { teams: { name: string }[] }).teams.some(
        (t) => t.name === "roster-team",
      ),
    ).toBe(true);
  });
});
