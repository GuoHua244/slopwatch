import { describe, expect, test } from "bun:test";
import { SCHEMA_VERSION } from "@slopwatch/events";
import { createApp, type App } from "./http";
import type { AdminUserRow, CommentRow, ReviewRow, Store } from "./store";

// Authorization must be decided before any storage write, so the in-memory
// tests run against a store that records the calls it receives.
const scriptedStore = (overrides: Partial<Store> = {}): Store => ({
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
  createRetro: async () => {
    throw new Error("retrospective store not scripted");
  },
  getRetro: async () => null,
  listRetros: async () => [],
  setRetroRunning: async () => {},
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
  close: async () => {},
  ...overrides,
});

const appWith = (store: Store, tokens: Record<string, string>): App =>
  createApp({ tokens: new Map(Object.entries(tokens)), store });

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

describe("review plane authorization (in memory)", () => {
  test("POST review: 401 without a token, before touching the store", async () => {
    const app = appWith(scriptedStore(), {});
    const res = await req(app, "/sessions/sess_1/review", { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("POST review: 403 for a non-DRI user", async () => {
    let touched = false;
    const store = scriptedStore({
      isDri: async () => false,
      markReviewed: async () => {
        touched = true;
        throw new Error("must not be reached");
      },
    });
    const app = appWith(store, { "tok-dri": "dri" });
    const res = await req(
      app,
      "/sessions/sess_1/review",
      { method: "POST" },
      "tok-dri",
    );
    expect(res.status).toBe(403);
    expect(touched).toBe(false);
  });

  test("POST review: 200 with the review row for a DRI, 404 for an unknown session", async () => {
    const review: ReviewRow = {
      session_id: "sess_1",
      reviewer_id: "dri",
      reviewed_at: "2026-09-10T00:00:00.000Z",
    };
    const store = scriptedStore({
      isDri: async (name) => name === "dri",
      markReviewed: async (sessionId, reviewer) =>
        sessionId === "sess_1" ? { ...review, reviewer_id: reviewer } : null,
    });
    const app = appWith(store, { "tok-dri": "dri" });
    const ok = await req(
      app,
      "/sessions/sess_1/review",
      { method: "POST" },
      "tok-dri",
    );
    expect(ok.status).toBe(200);
    expect(
      ((await ok.json()) as { review: ReviewRow }).review.reviewer_id,
    ).toBe("dri");
    const missing = await req(
      app,
      "/sessions/sess_x/review",
      { method: "POST" },
      "tok-dri",
    );
    expect(missing.status).toBe(404);
  });

  test("DELETE review: 204 when present, 404 when absent, DRI-only", async () => {
    const store = scriptedStore({
      isDri: async (name) => name === "dri",
      unmarkReviewed: async (sessionId) => sessionId === "sess_1",
    });
    const app = appWith(store, { "tok-dri": "dri", "tok-dev": "intern" });
    const ok = await req(
      app,
      "/sessions/sess_1/review",
      { method: "DELETE" },
      "tok-dri",
    );
    expect(ok.status).toBe(204);
    const missing = await req(
      app,
      "/sessions/sess_x/review",
      { method: "DELETE" },
      "tok-dri",
    );
    expect(missing.status).toBe(404);
    const forbidden = await req(
      app,
      "/sessions/sess_1/review",
      { method: "DELETE" },
      "tok-dev",
    );
    expect(forbidden.status).toBe(403);
  });

  test("GET review and GET comments need a token (decision 22), then answer org-wide", async () => {
    const store = scriptedStore({
      reviewFor: async () => null,
      listComments: async () => [],
    });
    const app = appWith(store, { "tok-dev": "dev" });
    expect((await req(app, "/sessions/sess_1/review")).status).toBe(401);
    expect((await req(app, "/sessions/sess_1/comments")).status).toBe(401);
    expect(
      (await req(app, "/sessions/sess_1/review", {}, "tok-dev")).status,
    ).toBe(200);
    expect(
      (await req(app, "/sessions/sess_1/comments", {}, "tok-dev")).status,
    ).toBe(200);
  });

  test("POST comment: 401 unauthenticated, 400 empty body, 201 with the comment", async () => {
    const comment: CommentRow = {
      comment_id: 1,
      session_id: "sess_1",
      turn_id: "turn_1",
      author_id: "alice",
      body: "note",
      created_at: "2026-09-10T00:00:00.000Z",
    };
    let receivedTurn: string | null | undefined;
    const store = scriptedStore({
      addComment: async (_s, turnId, authorId, body) => {
        receivedTurn = turnId;
        return { ...comment, turn_id: turnId, author_id: authorId, body };
      },
    });
    const app = appWith(store, { "tok-alice": "alice" });

    expect(
      (await req(app, "/sessions/sess_1/comments", { method: "POST" })).status,
    ).toBe(401);

    const empty = await req(
      app,
      "/sessions/sess_1/comments",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "  " }),
      },
      "tok-alice",
    );
    expect(empty.status).toBe(400);

    const ok = await req(
      app,
      "/sessions/sess_1/comments",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "note", turn_id: "turn_1" }),
      },
      "tok-alice",
    );
    expect(ok.status).toBe(201);
    expect(receivedTurn).toBe("turn_1");
    expect(
      ((await ok.json()) as { comment: CommentRow }).comment.author_id,
    ).toBe("alice");
  });

  test("DELETE comment: 401 unauthenticated, 204 for the author, 404 otherwise", async () => {
    let deleted: { commentId: number; authorId: string } | undefined;
    const store = scriptedStore({
      deleteComment: async (commentId, authorId) => {
        deleted = { commentId, authorId };
        return commentId === 7 && authorId === "alice";
      },
    });
    const app = appWith(store, { "tok-alice": "alice" });

    expect(
      (await req(app, "/sessions/sess_1/comments/7", { method: "DELETE" }))
        .status,
    ).toBe(401);
    expect(deleted).toBeUndefined();

    const ok = await req(
      app,
      "/sessions/sess_1/comments/7",
      { method: "DELETE" },
      "tok-alice",
    );
    expect(ok.status).toBe(204);
    expect(deleted).toEqual({ commentId: 7, authorId: "alice" });

    // a foreign or unknown note id answers 404, never 403 — nothing to probe
    expect(
      (
        await req(
          app,
          "/sessions/sess_1/comments/8",
          { method: "DELETE" },
          "tok-alice",
        )
      ).status,
    ).toBe(404);
  });

  test("GET /me identifies the token's user, role, and DRI flag", async () => {
    const store = scriptedStore({
      getUser: async (name) => ({
        name,
        email: null,
        disabled: false,
        is_dri: name === "dri",
        role: "member",
        created_at: "2026-09-10T00:00:00.000Z",
        active_tokens: 0,
        team_id: null,
        team_name: null,
      }),
    });
    const app = appWith(store, { "tok-dri": "dri", "tok-dev": "dev" });
    const dri = await req(app, "/me", {}, "tok-dri");
    expect(dri.status).toBe(200);
    expect((await dri.json()) as Record<string, unknown>).toEqual({
      user: "dri",
      role: "member",
      email: null,
      team_name: null,
      is_dri: true,
      created_at: "2026-09-10T00:00:00.000Z",
      llm: null,
      usage: {
        sessions: 0,
        first_seen_at: null,
        last_seen_at: null,
        turns: 0,
        tool_calls: 0,
        model_totals: [],
      },
    });
    expect((await req(app, "/me", {}, "tok-dev")).status).toBe(200);
    expect((await req(app, "/me")).status).toBe(401);
  });

  test("GET /me provisions a missing user row on first sight", async () => {
    let provisioned: string | undefined;
    const store = scriptedStore({
      ensureUser: async (name) => {
        provisioned = name;
        return true;
      },
      getUser: async (name) => ({
        name,
        email: "alice@corp.dev",
        disabled: false,
        is_dri: false,
        role: "admin",
        created_at: "2026-09-01T00:00:00.000Z",
        active_tokens: 1,
        team_id: null,
        team_name: "platform",
      }),
      roleOf: async () => "admin",
    });
    const app = appWith(store, { "tok-alice": "alice" });
    const res = await req(app, "/me", {}, "tok-alice");
    expect(res.status).toBe(200);
    expect(provisioned).toBe("alice");
    const body = (await res.json()) as {
      role: string;
      email: string | null;
      team_name: string | null;
      created_at: string | null;
    };
    expect(body.role).toBe("admin");
    expect(body.email).toBe("alice@corp.dev");
    expect(body.team_name).toBe("platform");
    expect(body.created_at).toBe("2026-09-01T00:00:00.000Z");
  });

  test("admin PATCH accepts is_dri alone and persists it", async () => {
    const user: AdminUserRow = {
      name: "alice",
      email: null,
      disabled: false,
      is_dri: true,
      role: "member",
      created_at: "2026-09-10T00:00:00.000Z",
      active_tokens: 0,
      team_id: null,
      team_name: null,
    };
    let called: boolean | undefined;
    const store = scriptedStore({
      setUserDri: async (_name, isDri) => {
        called = isDri;
        return user;
      },
      getUser: async () => user,
    });
    const app = createApp({
      tokens: new Map(),
      store,
      adminToken: "adm",
    });
    const res = await req(
      app,
      "/admin/users/alice",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ is_dri: true }),
      },
      "adm",
    );
    expect(res.status).toBe(200);
    expect(called).toBe(true);
    const bad = await req(
      app,
      "/admin/users/alice",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ is_dri: "yes" }),
      },
      "adm",
    );
    expect(bad.status).toBe(400);
  });
});

// --- DB-backed lifecycle tests (require DATABASE_URL_TEST / DATABASE_URL) ---

const dbTests = () =>
  (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL) !== undefined;
const testDsn = () =>
  (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL)!;

describe.skipIf(!dbTests())("review semantics against Postgres", () => {
  let store: Store;
  let app: App;
  let driToken: string;
  let devToken: string;

  const unique = (prefix: string): string =>
    `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

  test("bootstrap", async () => {
    const { createPgStore } = await import("./store");
    store = createPgStore(testDsn());
    await store.migrate();
    app = createApp({ tokens: new Map(), store });

    const dri = unique("dri");
    const dev = unique("dev");
    await store.createUser(dri, null);
    await store.createUser(dev, null);
    driToken = (await store.mintToken(dri)).token;
    devToken = (await store.mintToken(dev)).token;
    await store.setUserDri(dri, true);
    expect(await store.isDri(dri)).toBe(true);
    expect(await store.isDri(dev)).toBe(false);
  });

  test("mark, read, and retract a review over HTTP", async () => {
    const sessionId = unique("sess_review");
    await store.appendEvents(
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
      ],
      "alice",
    );

    expect(
      (
        await req(
          app,
          `/sessions/${sessionId}/review`,
          { method: "POST" },
          devToken,
        )
      ).status,
    ).toBe(403);

    const ok = await req(
      app,
      `/sessions/${sessionId}/review`,
      { method: "POST" },
      driToken,
    );
    expect(ok.status).toBe(200);
    const first = ((await ok.json()) as { review: ReviewRow }).review;
    expect(first.reviewer_id.startsWith("dri-")).toBe(true);

    // upsert: a second DRI review replaces the first
    const read = await req(app, `/sessions/${sessionId}/review`, {}, devToken);
    expect(
      ((await read.json()) as { review: ReviewRow | null }).review,
    ).toEqual(first);

    expect(
      (
        await req(
          app,
          `/sessions/${sessionId}/review`,
          { method: "DELETE" },
          driToken,
        )
      ).status,
    ).toBe(204);
    const gone = await req(app, `/sessions/${sessionId}/review`, {}, devToken);
    expect(
      ((await gone.json()) as { review: ReviewRow | null }).review,
    ).toBeNull();
    expect(
      (
        await req(
          app,
          `/sessions/${sessionId}/review`,
          { method: "DELETE" },
          driToken,
        )
      ).status,
    ).toBe(404);
  });

  test("comments attach to turns and the session, list in order", async () => {
    const sessionId = unique("sess_comments");
    await store.appendEvents(
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
      ],
      "alice",
    );

    const turnNote = await req(
      app,
      `/sessions/${sessionId}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: "this turn looped twice",
          turn_id: "turn_1",
        }),
      },
      devToken,
    );
    expect(turnNote.status).toBe(201);
    const sessionNote = await req(
      app,
      `/sessions/${sessionId}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "reviewed, looks fine" }),
      },
      driToken,
    );
    expect(sessionNote.status).toBe(201);

    const listed = await req(
      app,
      `/sessions/${sessionId}/comments`,
      {},
      devToken,
    );
    const { comments } = (await listed.json()) as { comments: CommentRow[] };
    expect(comments.map((c) => [c.turn_id, c.body])).toEqual([
      ["turn_1", "this turn looped twice"],
      [null, "reviewed, looks fine"],
    ]);
  });

  test("an author deletes their own note, never anyone else's", async () => {
    const sessionId = unique("sess_note_delete");
    await store.appendEvents(
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
      ],
      "alice",
    );

    const mine = await req(
      app,
      `/sessions/${sessionId}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "typo in my note, removing it" }),
      },
      devToken,
    );
    expect(mine.status).toBe(201);
    const mineId = ((await mine.json()) as { comment: CommentRow }).comment
      .comment_id;

    const theirs = await store.addComment(
      sessionId,
      null,
      "collaborator",
      "someone else's note",
    );
    expect(theirs).not.toBeNull();
    const theirsId = theirs!.comment_id;

    // another author's note is not deletable, and it stays listed
    expect(
      (
        await req(
          app,
          `/sessions/${sessionId}/comments/${theirsId}`,
          { method: "DELETE" },
          devToken,
        )
      ).status,
    ).toBe(404);

    expect(
      (
        await req(
          app,
          `/sessions/${sessionId}/comments/${mineId}`,
          { method: "DELETE" },
          devToken,
        )
      ).status,
    ).toBe(204);

    const listed = await req(
      app,
      `/sessions/${sessionId}/comments`,
      {},
      devToken,
    );
    const { comments } = (await listed.json()) as { comments: CommentRow[] };
    expect(comments.map((c) => c.comment_id)).toEqual([theirsId]);

    // an already-deleted note is gone for everyone
    expect(
      (
        await req(
          app,
          `/sessions/${sessionId}/comments/${mineId}`,
          { method: "DELETE" },
          devToken,
        )
      ).status,
    ).toBe(404);
  });

  test("deleting a session cascades its reviews and comments", async () => {
    const sessionId = unique("sess_cascade");
    await store.appendEvents(
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
      ],
      "alice",
    );
    await store.markReviewed(sessionId, "dri");
    await store.addComment(sessionId, null, "alice", "note");

    expect(await store.deleteSession(sessionId)).toBe(true);
    expect(await store.reviewFor(sessionId)).toBeNull();
    expect(await store.listComments(sessionId)).toEqual([]);
  });
});
