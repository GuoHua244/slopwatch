import { describe, expect, test } from "bun:test";
import { createApp, type App } from "./http";
import {
  hashToken,
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
      created_at: string;
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
  const seenSessions = new Set<string>();
  const sessionEvents = new Map<string, number>();
  const row = (name: string): AdminUserRow => ({
    name,
    email: users.get(name)!.email,
    disabled: users.get(name)!.disabled,
    is_dri: users.get(name)!.is_dri,
    created_at: users.get(name)!.created_at,
    active_tokens: [...tokens.values()].filter(
      (t) => t.user === name && t.revoked_at === null,
    ).length,
  });
  const store: Store = {
    migrate: async () => {},
    appendEvents: async (events_: unknown[]) => {
      for (const e of events_ as { session_id: string }[]) {
        if (!seenSessions.has(e.session_id)) {
          seenSessions.add(e.session_id);
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
    pruneRawOlderThan: async () => 0,
    backfillTokenTotals: async () => 0,
    createUser: async (name, email) => {
      if (users.has(name)) throw new UserExistsError(name);
      users.set(name, {
        email,
        disabled: false,
        is_dri: false,
        created_at: new Date().toISOString(),
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
    markReviewed: async () => null,
    unmarkReviewed: async () => false,
    reviewFor: async () => null,
    addComment: async () => null,
    listComments: async () => [],
    isDri: async () => false,
    health: async () => ({
      sessions,
      events,
      last_event_at: events > 0 ? new Date().toISOString() : null,
    }),
    close: async () => {},
  };
  return { store, tokens, users };
};

const appWith = (opts: { adminToken?: string; store: Store }): App =>
  createApp({ tokens: new Map(), ...opts });

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
  const { store } = memStore();

  test("404 when the admin token is not configured", async () => {
    const res = await admin(appWith({ store }), "GET", "/admin/users");
    expect(res.status).toBe(404);
  });

  test("401 without a bearer token", async () => {
    const res = await admin(
      appWith({ adminToken: "admin-tok", store }),
      "GET",
      "/admin/users",
      undefined,
      "",
    );
    expect(res.status).toBe(401);
  });

  test("401 with the wrong token", async () => {
    const res = await admin(
      appWith({ adminToken: "admin-tok", store }),
      "GET",
      "/admin/users",
      undefined,
      "nope",
    );
    expect(res.status).toBe(401);
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
