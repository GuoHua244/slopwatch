import { describe, expect, test } from "bun:test";
import { createApp, type App } from "./http";
import {
  createPgStore,
  UserExistsError,
  type AdminUserRow,
  type AuditEntry,
  type CommentRow,
  type ReviewRow,
  type Role,
  type SessionRow,
  type Store,
  type TeamRow,
} from "./store";

// ADR 0007: every route-level audit assertion runs against a store that
// records the entries it is asked to append.
const auditStore = (
  overrides: Partial<Store> = {},
): Store & { audits: AuditEntry[] } => {
  const audits: AuditEntry[] = [];
  const base: Store = {
    migrate: async () => {},
    appendEvents: async () => ({ accepted: 0 }),
    listSessions: async () => [],
    eventsSince: async () => [],
    getAttachment: async () => null,
    deleteSession: async () => false,
    touchSession: async () => false,
    sessionBurnSnapshot: async () => null,
    hourTokenTotal: async () => 0,
    hasAudit: async () => false,
    pruneRaw: async () => ({ archived: 0, pruned: 0 }),
    getSetting: async () => null,
    setSetting: async () => {},
    clearSetting: async () => {},
    listSettings: async () => ({}),
    appendAudit: async (entry) => {
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
    setUserTeam: async () => null,
    createTeam: async () => {
      throw new Error("not scripted");
    },
    listTeams: async () => [],
    updateTeam: async () => null,
    deleteTeam: async () => false,
    teamsWithMembers: async () => [],
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
    markReviewed: async () => {
      throw new Error("not scripted");
    },
    unmarkReviewed: async () => {
      throw new Error("not scripted");
    },
    reviewFor: async () => null,
    addComment: async () => {
      throw new Error("not scripted");
    },
    listComments: async () => [],
    deleteComment: async () => false,
    isDri: async () => false,
    setUserDri: async () => null,
    roleOf: async () => "member" as Role,
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
    createRetro: async () => {
      throw new Error("retrospective store not scripted");
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
  return Object.assign(base, { audits }, overrides);
};

const appWith = (
  store: Store,
  opts: { adminToken?: string; tokens?: Record<string, string> } = {},
): App =>
  createApp({
    store,
    tokens: new Map(Object.entries(opts.tokens ?? {})),
    adminToken: opts.adminToken,
  });

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

const userRow = (over: Partial<AdminUserRow> = {}): AdminUserRow =>
  ({
    name: "bob",
    email: null,
    disabled: false,
    is_dri: false,
    role: "member",
    created_at: "2026-09-01T00:00:00.000Z",
    active_tokens: 0,
    password_set: false,
    team_id: null,
    team_name: null,
    ...over,
  }) as AdminUserRow;

describe("audit trail (in memory)", () => {
  test("admin user create is attributed to the acting admin", async () => {
    const store = auditStore({
      roleOf: async () => "admin",
      createUser: async () => userRow({ name: "bob", email: "b@corp.dev" }),
    });
    const app = appWith(store, { tokens: { "tok-admin": "guohua" } });
    const res = await req(
      app,
      "/admin/users",
      {
        method: "POST",
        body: JSON.stringify({ name: "bob", email: "b@corp.dev" }),
      },
      "tok-admin",
    );
    expect(res.status).toBe(201);
    expect(store.audits).toEqual([
      {
        actor: { kind: "user", user: "guohua" },
        action: "user.create",
        target: "bob",
        detail: { email: "b@corp.dev" },
      },
    ]);
  });

  test("the operator bypass attributes to the operator pseudo-actor", async () => {
    const store = auditStore({
      createUser: async () => userRow({ name: "bob" }),
    });
    const app = appWith(store, { adminToken: "op-token" });
    const res = await req(
      app,
      "/admin/users",
      { method: "POST", body: JSON.stringify({ name: "bob" }) },
      "op-token",
    );
    expect(res.status).toBe(201);
    expect(store.audits).toEqual([
      {
        actor: { kind: "operator" },
        action: "user.create",
        target: "bob",
        detail: { email: null },
      },
    ]);
  });

  test("user patch records only the fields that moved", async () => {
    let user = userRow({ team_name: "platform" });
    const store = auditStore({
      roleOf: async () => "admin",
      getUser: async () => ({ ...user }),
      setUserRole: async () => {
        user = { ...user, role: "admin" };
        return { ...user };
      },
    });
    const app = appWith(store, { tokens: { "tok-admin": "guohua" } });
    const res = await req(
      app,
      "/admin/users/bob",
      { method: "PATCH", body: JSON.stringify({ role: "admin" }) },
      "tok-admin",
    );
    expect(res.status).toBe(200);
    expect(store.audits).toEqual([
      {
        actor: { kind: "user", user: "guohua" },
        action: "user.update",
        target: "bob",
        detail: {
          changes: { role: { before: "member", after: "admin" } },
        },
      },
    ]);
  });

  test("user delete snapshots what vanished", async () => {
    const store = auditStore({
      roleOf: async () => "admin",
      getUser: async () =>
        userRow({
          email: "b@corp.dev",
          role: "admin",
          active_tokens: 2,
          team_name: "platform",
        }),
      deleteUser: async () => true,
    });
    const app = appWith(store, { tokens: { "tok-admin": "guohua" } });
    const res = await req(
      app,
      "/admin/users/bob",
      { method: "DELETE" },
      "tok-admin",
    );
    expect(res.status).toBe(200);
    expect(store.audits).toEqual([
      {
        actor: { kind: "user", user: "guohua" },
        action: "user.delete",
        target: "bob",
        detail: {
          email: "b@corp.dev",
          team: "platform",
          role: "admin",
          active_tokens: 2,
        },
      },
    ]);
  });

  test("rejected mutations leave no entry", async () => {
    const store = auditStore({
      roleOf: async () => "admin",
      createUser: async () => {
        throw new UserExistsError("bob");
      },
    });
    const app = appWith(store, { tokens: { "tok-admin": "guohua" } });
    const conflict = await req(
      app,
      "/admin/users",
      { method: "POST", body: JSON.stringify({ name: "bob" }) },
      "tok-admin",
    );
    expect(conflict.status).toBe(409);
    const missing = await req(
      app,
      "/admin/users/ghost",
      { method: "PATCH", body: JSON.stringify({ disabled: true }) },
      "tok-admin",
    );
    expect(missing.status).toBe(404);
    const member = await req(
      app,
      "/admin/users",
      { method: "POST", body: JSON.stringify({ name: "bob" }) },
      "tok-member",
    );
    expect(member.status).toBe(401);
    expect(store.audits).toEqual([]);
  });

  test("session delete carries the pre-delete snapshot", async () => {
    const snap: SessionRow = {
      session_id: "sess_1",
      agent: "zcode",
      user_id: "bob",
      team_id: null,
      first_seen_at: "2026-09-01T00:00:00.000Z",
      last_event_at: "2026-09-01T01:00:00.000Z",
      last_seq: 12,
      title: "fix the login bug",
      task_preview: null,
      total_input_tokens: 100,
      total_output_tokens: 50,
      total_cache_read_tokens: 10,
      total_cache_write_tokens: 5,
      failed_tool_calls: 0,
      repeated_calls: 0,
      parent_session_id: null,
    };
    const store = auditStore({
      roleOf: async () => "admin",
      getSession: async () => snap,
      deleteSession: async () => true,
    });
    const app = appWith(store, { tokens: { "tok-admin": "guohua" } });
    const res = await req(
      app,
      "/admin/sessions/sess_1",
      { method: "DELETE" },
      "tok-admin",
    );
    expect(res.status).toBe(200);
    expect(store.audits).toEqual([
      {
        actor: { kind: "user", user: "guohua" },
        action: "session.delete",
        target: "sess_1",
        detail: {
          agent: "zcode",
          user: "bob",
          title: "fix the login bug",
          events: 12,
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 10,
          cache_write_tokens: 5,
        },
      },
    ]);
  });

  test("token mint and revoke land with hint context", async () => {
    const store = auditStore({
      roleOf: async () => "admin",
      getUser: async () => userRow(),
      mintToken: async (_name, label) => ({
        token_id: "a1b2c3d4-0000-4000-8000-0000000000b2",
        hint: "sw_abcd1234",
        token: "sw_secret",
        label: label ?? null,
      }),
      getToken: async () => ({
        token_id: "a1b2c3d4-0000-4000-8000-0000000000b2",
        hint: "sw_abcd1234",
        label: "ci",
        user_name: "bob",
        created_at: "2026-09-01T00:00:00.000Z",
        revoked_at: null,
      }),
      revokeToken: async () => true,
    });
    const app = appWith(store, { tokens: { "tok-admin": "guohua" } });
    const minted = await req(
      app,
      "/admin/users/bob/tokens",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "ci" }),
      },
      "tok-admin",
    );
    expect(minted.status).toBe(201);
    const revoked = await req(
      app,
      "/admin/tokens/a1b2c3d4-0000-4000-8000-0000000000b2",
      { method: "DELETE" },
      "tok-admin",
    );
    expect(revoked.status).toBe(200);
    expect(store.audits).toEqual([
      {
        actor: { kind: "user", user: "guohua" },
        action: "token.mint",
        target: "bob",
        detail: {
          token_id: "a1b2c3d4-0000-4000-8000-0000000000b2",
          hint: "sw_abcd1234",
          label: "ci",
        },
      },
      {
        actor: { kind: "user", user: "guohua" },
        action: "token.revoke",
        target: "bob",
        detail: {
          token_id: "a1b2c3d4-0000-4000-8000-0000000000b2",
          hint: "sw_abcd1234",
          label: "ci",
          user: "bob",
        },
      },
    ]);
  });

  test("settings update diffs before and after per key", async () => {
    const stored: Record<string, string> = {};
    const store = auditStore({
      roleOf: async () => "admin",
      getSetting: async (key) => stored[key] ?? null,
      setSetting: async (key, value) => {
        stored[key] = value;
      },
      clearSetting: async (key) => {
        delete stored[key];
      },
      listSettings: async () => ({ ...stored }),
    });
    const app = appWith(store, { tokens: { "tok-admin": "guohua" } });
    stored.webhook_url = "https://old.example/hook";
    const res = await req(
      app,
      "/admin/settings",
      {
        method: "PUT",
        body: JSON.stringify({
          webhook_url: null,
          webhook_enabled: "false",
        }),
      },
      "tok-admin",
    );
    expect(res.status).toBe(200);
    expect(store.audits).toEqual([
      {
        actor: { kind: "user", user: "guohua" },
        action: "settings.update",
        target: "webhook_url, webhook_enabled",
        detail: {
          changes: {
            webhook_enabled: { before: null, after: "false" },
            webhook_url: { before: "https://old.example/hook", after: null },
          },
        },
      },
    ]);
  });

  test("team create, update, and delete all leave entries", async () => {
    let team: TeamRow = {
      id: "a1b2c3d4-0000-4000-8000-0000000000a1",
      name: "platform",
      raw_retention_days: null,
      created_at: "2026-09-01T00:00:00.000Z",
      member_count: 3,
    };
    const store = auditStore({
      roleOf: async () => "admin",
      getTeam: async () => ({ ...team }),
      createTeam: async () => ({ ...team }),
      updateTeam: async () => {
        team = { ...team, raw_retention_days: 30 };
        return { ...team };
      },
      deleteTeam: async () => true,
    });
    const app = appWith(store, { tokens: { "tok-admin": "guohua" } });
    expect(
      (
        await req(
          app,
          "/admin/teams",
          { method: "POST", body: JSON.stringify({ name: "platform" }) },
          "tok-admin",
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await req(
          app,
          "/admin/teams/a1b2c3d4-0000-4000-8000-0000000000a1",
          { method: "PATCH", body: JSON.stringify({ raw_retention_days: 30 }) },
          "tok-admin",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await req(
          app,
          "/admin/teams/a1b2c3d4-0000-4000-8000-0000000000a1",
          { method: "DELETE" },
          "tok-admin",
        )
      ).status,
    ).toBe(200);
    expect(store.audits).toEqual([
      {
        actor: { kind: "user", user: "guohua" },
        action: "team.create",
        target: "platform",
        detail: {
          id: "a1b2c3d4-0000-4000-8000-0000000000a1",
          raw_retention_days: null,
        },
      },
      {
        actor: { kind: "user", user: "guohua" },
        action: "team.update",
        target: "platform",
        detail: {
          id: "a1b2c3d4-0000-4000-8000-0000000000a1",
          changes: {
            raw_retention_days: { before: null, after: 30 },
          },
        },
      },
      {
        actor: { kind: "user", user: "guohua" },
        action: "team.delete",
        target: "platform",
        detail: { id: "a1b2c3d4-0000-4000-8000-0000000000a1", member_count: 3 },
      },
    ]);
  });

  test("review mark/unmark and the note lifecycle land with user actors", async () => {
    const note: CommentRow = {
      comment_id: 7,
      session_id: "sess_1",
      turn_id: null,
      author_id: "alice",
      body: "this turn regressed the build",
      created_at: "2026-09-01T00:00:00.000Z",
    };
    const review: ReviewRow = {
      session_id: "sess_1",
      reviewer_id: "alice",
      reviewed_at: "2026-09-01T00:00:00.000Z",
    };
    const store = auditStore({
      isDri: async () => true,
      markReviewed: async () => review,
      unmarkReviewed: async () => true,
      addComment: async () => note,
      getComment: async () => note,
      deleteComment: async () => true,
    });
    const app = appWith(store, { tokens: { "tok-alice": "alice" } });
    expect(
      (
        await req(
          app,
          "/sessions/sess_1/review",
          { method: "POST" },
          "tok-alice",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await req(
          app,
          "/sessions/sess_1/review",
          { method: "DELETE" },
          "tok-alice",
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await req(
          app,
          "/sessions/sess_1/comments",
          {
            method: "POST",
            body: JSON.stringify({ body: "this turn regressed the build" }),
          },
          "tok-alice",
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await req(
          app,
          "/sessions/sess_1/comments/7",
          { method: "DELETE" },
          "tok-alice",
        )
      ).status,
    ).toBe(204);
    expect(store.audits).toEqual([
      {
        actor: { kind: "user", user: "alice" },
        action: "review.mark",
        target: "sess_1",
        detail: undefined,
      },
      {
        actor: { kind: "user", user: "alice" },
        action: "review.unmark",
        target: "sess_1",
        detail: undefined,
      },
      {
        actor: { kind: "user", user: "alice" },
        action: "note.add",
        target: "sess_1",
        detail: { comment_id: 7, turn_id: null },
      },
      {
        actor: { kind: "user", user: "alice" },
        action: "note.delete",
        target: "sess_1",
        detail: {
          comment_id: 7,
          turn_id: null,
          author: "alice",
          body_preview: "this turn regressed the build",
        },
      },
    ]);
  });

  test("first-sight /me provisioning is audited, repeat reads are not", async () => {
    const store = auditStore({
      roleOf: async () => "member",
      ensureUser: async () => true,
      getUser: async () => userRow({ name: "alice" }),
    });
    const app = appWith(store, { tokens: { "tok-alice": "alice" } });
    expect((await req(app, "/me", {}, "tok-alice")).status).toBe(200);
    expect(store.audits).toEqual([
      {
        actor: { kind: "user", user: "alice" },
        action: "user.provision",
        target: "alice",
        detail: { via: "sign-in" },
      },
    ]);
    store.audits.length = 0;
    const again = auditStore({
      roleOf: async () => "member",
      ensureUser: async () => false,
      getUser: async () => userRow({ name: "alice" }),
    });
    const app2 = appWith(again, { tokens: { "tok-alice": "alice" } });
    expect((await req(app2, "/me", {}, "tok-alice")).status).toBe(200);
    expect(again.audits).toEqual([]);
  });

  test("GET /admin/audit passes the filter read and stays admin-only", async () => {
    let seen: unknown;
    const store = auditStore({
      roleOf: async (name) => (name === "guohua" ? "admin" : "member"),
      listAudit: async (opts) => {
        seen = opts;
        return { rows: [], total: 0 };
      },
    });
    const app = appWith(store, {
      tokens: { "tok-admin": "guohua", "tok-mem": "bob" },
    });
    const res = await req(
      app,
      "/admin/audit?kind=user&actor=guohua&limit=10&offset=20",
      {},
      "tok-admin",
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual({
      limit: 10,
      offset: 20,
      kind: "user",
      actor: "guohua",
    });
    expect((await req(app, "/admin/audit", {}, "tok-mem")).status).toBe(403);
    expect((await req(app, "/admin/audit", {}, "tok-stranger")).status).toBe(
      401,
    );
    expect(
      (await req(app, "/admin/audit?kind=user.", {}, "tok-admin")).status,
    ).toBe(200);
    expect((seen as { kind: string }).kind).toBe("user");
  });
});

const dbTests = () =>
  (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL) !== undefined;
const testDsn = () =>
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!;

describe.skipIf(!dbTests())("audit store against Postgres", () => {
  test("appendAudit and listAudit round-trip with filters and paging", async () => {
    const store = createPgStore(testDsn());
    await store.migrate();
    const marker = crypto.randomUUID().slice(0, 8);
    const name = `audit-pg-${marker}`;
    await store.appendAudit({
      actor: { kind: "user", user: name },
      action: "user.create",
      target: name,
      detail: { email: null },
    });
    await store.appendAudit({
      actor: { kind: "operator" },
      action: "settings.update",
      target: "webhook_url",
      detail: { changes: { webhook_url: { before: null, after: "x" } } },
    });
    await store.appendAudit({
      actor: { kind: "system" },
      action: "events.prune",
      target: "events",
      detail: { pruned: 3, archived: 1 },
    });
    // a second events.* row keeps the paging assertion below self-contained —
    // the audit log is shared state, and on a fresh CI database nothing else
    // has written events.* rows yet, so offset:1 would come up empty
    await store.appendAudit({
      actor: { kind: "system" },
      action: "events.archive",
      target: "events",
      detail: { archived: 2 },
    });

    const all = await store.listAudit({ limit: 10, offset: 0 });
    expect(all.total).toBeGreaterThanOrEqual(3);
    const seqs = all.rows.map((r) => r.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));

    const byKind = await store.listAudit({
      limit: 10,
      offset: 0,
      kind: "user",
    });
    expect(byKind.rows.every((r) => r.action.startsWith("user."))).toBe(true);
    expect(
      byKind.rows.some(
        (r) =>
          r.target === name && r.actor_user === name && r.actor_kind === "user",
      ),
    ).toBe(true);

    const byActor = await store.listAudit({
      limit: 10,
      offset: 0,
      actor: name,
    });
    expect(byActor.rows.length).toBeGreaterThan(0);
    expect(byActor.rows.every((r) => r.actor_user === name)).toBe(true);

    const system = await store.listAudit({
      limit: 10,
      offset: 0,
      actor: "system",
    });
    expect(system.rows.some((r) => r.action === "events.prune")).toBe(true);

    const paged = await store.listAudit({
      limit: 1,
      offset: 1,
      kind: "events",
    });
    expect(paged.rows.length).toBe(1);
    expect(paged.rows[0]!.action).toBe("events.prune");
    expect(paged.total).toBeGreaterThanOrEqual(1);
    await store.close();
  });

  test("ensureUser reports creation exactly once", async () => {
    const store = createPgStore(testDsn());
    await store.migrate();
    const name = `audit-pg-${crypto.randomUUID().slice(0, 8)}`;
    expect(await store.ensureUser(name)).toBe(true);
    expect(await store.ensureUser(name)).toBe(false);
    await store.deleteUser(name);
    await store.close();
  });
});
