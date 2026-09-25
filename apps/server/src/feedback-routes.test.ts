import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createApp, type App } from "./http";
import type { FeedbackRow, SessionRow, Store } from "./store";

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);

const sessionRow = (sessionId: string): SessionRow => ({
  session_id: sessionId,
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

// ADR 0009 route tests over a scripted store: any signed-in user files,
// session anchors follow the events-route read scope, the multipart intake
// enforces the form contract, and both verbs audit.
const scriptedStore = (overrides: Partial<Store> = {}) => {
  const audits: {
    actor: unknown;
    action: string;
    target: string;
    detail?: Record<string, unknown>;
  }[] = [];
  const rows: (FeedbackRow & {
    attachments: {
      sha256: string;
      filename: string;
      mime: string;
      size: number;
    }[];
  })[] = [];
  const blobs = new Map<string, Buffer>();
  let seq = 0;
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
      actor: unknown;
      action: string;
      target: string;
      detail?: Record<string, unknown>;
    }) => {
      audits.push(entry);
    },
    listAudit: async () => ({ rows: [], total: 0 }),
    getSession: async (id: string) => (id === "sess-1" ? sessionRow(id) : null),
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
    roleOf: async (name: string) => (name === "admin" ? "admin" : "member"),
    setUserRole: async () => null,
    ensureUser: async () => false,
    ensureAdmin: async () => {},
    sessionOwner: async (id: string) => (id === "sess-1" ? "alice" : null),
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
    listRetros: async () => [],
    createRetro: (async () => {
      throw new Error("not scripted");
    }) as Store["createRetro"],
    getRetro: async () => null,
    setRetroRunning: async () => {},
    setRetroCompleted: async () => {},
    setRetroFailed: async () => {},
    failStaleRetros: async () => 0,
    addFeedback: async (input: {
      filerId: string;
      kind: string;
      body: string;
      sessionId: string | null;
    }) => {
      if (input.sessionId !== null && input.sessionId !== "sess-1") return null;
      const row = {
        feedback_id: ++seq,
        filer_id: input.filerId,
        session_id: input.sessionId,
        kind: input.kind as FeedbackRow["kind"],
        body: input.body,
        created_at: new Date().toISOString(),
        attachments: [],
      };
      rows.push(row);
      // A copy, like pg: the store answers with a snapshot, not a live row —
      // the route must re-read after writing attachments (regression guard).
      return { ...row, attachments: [...row.attachments] };
    },
    getFeedback: async (id: number) =>
      rows.find((r) => r.feedback_id === id) ?? null,
    listFeedback: async (opts: {
      limit: number;
      offset: number;
      kind?: string;
    }) => {
      const all = [...rows]
        .reverse()
        .filter((r) => !opts.kind || r.kind === opts.kind);
      return {
        rows: all.slice(opts.offset, opts.offset + opts.limit),
        total: all.length,
      };
    },
    deleteFeedback: async (id: number) => {
      const i = rows.findIndex((r) => r.feedback_id === id);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    },
    addFeedbackAttachments: async (
      feedbackId: number,
      incoming: {
        sha256: string;
        filename: string;
        mime: string;
        size: number;
        data: Buffer;
      }[],
    ) => {
      const row = rows.find((r) => r.feedback_id === feedbackId);
      if (row === undefined) return;
      for (const f of incoming) {
        if (!row.attachments.some((x) => x.sha256 === f.sha256))
          row.attachments.push(f);
        blobs.set(f.sha256, f.data);
      }
    },
    getFeedbackAttachment: async (feedbackId: number, sha256: string) => {
      const row = rows.find((r) => r.feedback_id === feedbackId);
      const meta = row?.attachments.find((x) => x.sha256 === sha256);
      const data = blobs.get(sha256);
      return meta && data
        ? { mime: meta.mime, filename: meta.filename, data }
        : null;
    },
    ...overrides,
  };
  return {
    store: base as Store,
    audits,
  };
};

const appWith = (store: Store, adminToken?: string): App =>
  createApp({
    tokens: new Map([
      ["tok-alice", "alice"],
      ["tok-bob", "bob"],
      ["tok-admin", "admin"],
    ]),
    store,
    adminToken,
  });

const pngSha = createHash("sha256").update(png).digest("hex");

const feedbackForm = (
  patch: { kind?: string; text?: string } = {},
  files: File[] = [],
): FormData => {
  const form = new FormData();
  form.set("kind", patch.kind ?? "missing_content");
  form.set("text", patch.text ?? "turn 3 vanished");
  for (const f of files) form.append("files", f);
  return form;
};

const post = (app: App, path: string, token: string, body: BodyInit) =>
  app.fetch(
    new Request(`http://x${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body,
    }),
  );

const adminGet = (app: App, path: string, token = "admin-tok") =>
  app.fetch(
    new Request(`http://x${path}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );

const adminDelete = (app: App, path: string, token = "admin-tok") =>
  app.fetch(
    new Request(`http://x${path}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    }),
  );

describe("feedback routes (ADR 0009)", () => {
  test("POST /feedback files a global feedback with attachments and audits it", async () => {
    const { store, audits } = scriptedStore();
    const app = appWith(store, "admin-tok");
    const res = await post(
      app,
      "/feedback",
      "tok-alice",
      feedbackForm({}, [new File([png], "shot.png", { type: "image/png" })]),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      feedback: FeedbackRow & {
        attachments: { sha256: string; filename: string; mime: string }[];
      };
    };
    expect(body.feedback.filer_id).toBe("alice");
    expect(body.feedback.session_id).toBeNull();
    expect(body.feedback.kind).toBe("missing_content");
    expect(body.feedback.attachments.length).toBe(1);
    expect(body.feedback.attachments[0]!.sha256).toBe(pngSha);
    expect(body.feedback.attachments[0]!.filename).toBe("shot.png");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("feedback.create");
    expect(audits[0]!.detail).toMatchObject({
      kind: "missing_content",
      session_id: null,
      attachments: 1,
    });
  });

  test("POST /feedback rejects a bad kind, an empty text, and an oversized text", async () => {
    const { store } = scriptedStore();
    const app = appWith(store, "admin-tok");
    expect(
      (
        await post(
          app,
          "/feedback",
          "tok-alice",
          feedbackForm({ kind: "nope" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await post(app, "/feedback", "tok-alice", feedbackForm({ text: "   " })))
        .status,
    ).toBe(400);
    expect(
      (
        await post(
          app,
          "/feedback",
          "tok-alice",
          feedbackForm({ text: "x".repeat(2001) }),
        )
      ).status,
    ).toBe(400);
  });

  test("POST /feedback enforces the attachment contract: unsupported type, oversize, count", async () => {
    const { store } = scriptedStore();
    const app = appWith(store, "admin-tok");
    const exe = new File([Buffer.from("MZ...")], "tool.exe", {
      type: "application/x-msdownload",
    });
    expect(
      (await post(app, "/feedback", "tok-alice", feedbackForm({}, [exe])))
        .status,
    ).toBe(415);

    const big = new File([Buffer.alloc(20 * 1024 * 1024 + 1)], "huge.bin", {
      type: "application/pdf",
    });
    expect(
      (await post(app, "/feedback", "tok-alice", feedbackForm({}, [big])))
        .status,
    ).toBe(413);

    const many = Array.from(
      { length: 11 },
      (_, i) => new File([png], `f${i}.png`, { type: "image/png" }),
    );
    expect(
      (await post(app, "/feedback", "tok-alice", feedbackForm({}, many)))
        .status,
    ).toBe(400);
  });

  test("POST /feedback without a bearer answers 401; a non-multipart body answers 400", async () => {
    const { store } = scriptedStore();
    const app = appWith(store, "admin-tok");
    const bare = await app.fetch(
      new Request("http://x/feedback", { method: "POST", body: "x" }),
    );
    expect(bare.status).toBe(401);
    const jsonBody = await post(
      app,
      "/feedback",
      "tok-alice",
      JSON.stringify({ kind: "other", text: "hi" }),
    );
    expect(jsonBody.status).toBe(400);
  });

  test("POST /sessions/:id/feedback follows the session read scope", async () => {
    const { store, audits } = scriptedStore();
    const app = appWith(store, "admin-tok");
    // the owner files happily
    const owned = await post(
      app,
      "/sessions/sess-1/feedback",
      "tok-alice",
      feedbackForm(),
    );
    expect(owned.status).toBe(201);
    // a member cannot flag someone else's session — 404, existence stays hidden
    const foreign = await post(
      app,
      "/sessions/sess-1/feedback",
      "tok-bob",
      feedbackForm(),
    );
    expect(foreign.status).toBe(404);
    // the admin anchors anywhere; an unknown session stays 404
    expect(
      (
        await post(
          app,
          "/sessions/sess-1/feedback",
          "tok-admin",
          feedbackForm(),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await post(
          app,
          "/sessions/sess-unknown/feedback",
          "tok-admin",
          feedbackForm(),
        )
      ).status,
    ).toBe(404);
    expect(audits.filter((a) => a.action === "feedback.create")).toHaveLength(
      2,
    );
  });

  test("GET /admin/feedback lists with filters; the member role is turned away", async () => {
    const { store } = scriptedStore();
    const app = appWith(store, "admin-tok");
    await post(app, "/feedback", "tok-alice", feedbackForm());
    await post(
      app,
      "/feedback",
      "tok-bob",
      feedbackForm({ kind: "other", text: "general gripe" }),
    );

    const all = await adminGet(app, "/admin/feedback");
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as { rows: unknown[]; total: number };
    expect(allBody.total).toBe(2);
    expect(allBody.rows).toHaveLength(2);

    const filtered = await adminGet(app, "/admin/feedback?kind=other");
    const filteredBody = (await filtered.json()) as {
      rows: FeedbackRow[];
      total: number;
    };
    expect(filteredBody.total).toBe(1);
    expect(filteredBody.rows[0]!.filer_id).toBe("bob");

    const paged = await adminGet(app, "/admin/feedback?limit=1&offset=1");
    const pagedBody = (await paged.json()) as {
      rows: unknown[];
      total: number;
    };
    expect(pagedBody.rows).toHaveLength(1);
    expect(pagedBody.total).toBe(2);

    expect((await adminGet(app, "/admin/feedback", "tok-alice")).status).toBe(
      403,
    );
  });

  test("DELETE /admin/feedback/:id snapshots into the audit trail; unknown ids 404", async () => {
    const { store, audits } = scriptedStore();
    const app = appWith(store, "admin-tok");
    const res = await post(
      app,
      "/feedback",
      "tok-alice",
      feedbackForm({}, [new File([png], "shot.png", { type: "image/png" })]),
    );
    const id = ((await res.json()) as { feedback: FeedbackRow }).feedback
      .feedback_id;

    const gone = await adminDelete(app, `/admin/feedback/${id}`);
    expect(gone.status).toBe(200);
    const del = audits.find((a) => a.action === "feedback.delete");
    expect(del).toBeDefined();
    expect(del!.detail).toMatchObject({
      feedback_id: id,
      filer_id: "alice",
    });
    expect((del!.detail?.attachments as unknown[]).length).toBe(1);
    expect((await adminDelete(app, `/admin/feedback/${id}`)).status).toBe(404);
  });

  test("attachment bytes serve through the admin plane only, content-typed", async () => {
    const { store } = scriptedStore();
    const app = appWith(store, "admin-tok");
    const res = await post(
      app,
      "/feedback",
      "tok-alice",
      feedbackForm({}, [new File([png], "shot.png", { type: "image/png" })]),
    );
    const id = ((await res.json()) as { feedback: FeedbackRow }).feedback
      .feedback_id;

    const bytes = await adminGet(
      app,
      `/admin/feedback/${id}/attachments/${pngSha}`,
    );
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(png);

    expect(
      (
        await adminGet(
          app,
          `/admin/feedback/${id}/attachments/${"f".repeat(64)}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await adminGet(
          app,
          `/admin/feedback/999/attachments/${pngSha}`,
          "tok-admin",
        )
      ).status,
    ).toBe(404);
    // the member plane never sees feedback attachments
    const member = await app.fetch(
      new Request(`http://x/admin/feedback/${id}/attachments/${pngSha}`, {
        headers: { authorization: "Bearer tok-alice" },
      }),
    );
    expect(member.status).toBe(403);
  });
});
