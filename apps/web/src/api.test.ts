import { describe, expect, test } from "bun:test";
import type { NormalEvent } from "@slopwatch/events";
import {
  ApiError,
  createAdminApi,
  createReviewApi,
  createApi,
  type MeInfo,
  type SessionSummary,
} from "./api";

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const session = (): SessionSummary => ({
  session_id: "sess_1",
  agent: "zcode",
  user_id: "alice",
  first_seen_at: "2026-09-09T15:26:58.337Z",
  last_event_at: null,
  last_seq: 3,
  title: "hello",
  task_preview: null,
  total_input_tokens: 100,
  total_output_tokens: 50,
  total_cache_read_tokens: 10,
  total_cache_write_tokens: 0,
  parent_session_id: null,
});

const modelRequest = (): NormalEvent => ({
  schema_version: 1,
  agent: "zcode",
  session_id: "sess_1",
  occurred_at: "2026-09-09T15:27:00.000Z",
  kind: "model_request",
  provider: "builtin:test",
  model: "m",
  duration_ms: 5,
});

describe("createApi", () => {
  test("listSessions GETs /sessions and unwraps the payload", async () => {
    const paths: string[] = [];
    const api = createApi((input) => {
      paths.push(String(input));
      return Promise.resolve(jsonResponse(200, { sessions: [session()] }));
    });
    const sessions = await api.listSessions();
    expect(paths).toEqual(["/sessions"]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.session_id).toBe("sess_1");
  });

  test("eventsSince GETs the incremental page with encoded session id", async () => {
    const paths: string[] = [];
    const api = createApi((input) => {
      paths.push(String(input));
      return Promise.resolve(
        jsonResponse(200, {
          session_id: "sess_a b",
          events: [{ event_seq: 4, event: modelRequest() }],
        }),
      );
    });
    const events = await api.eventsSince("sess_a b", 3);
    expect(paths).toEqual(["/sessions/sess_a%20b/events?since_seq=3"]);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_seq).toBe(4);
    expect(events[0]!.event.kind).toBe("model_request");
  });

  test("rollups forwards window params and the team scope as a query string", async () => {
    const paths: string[] = [];
    const api = createApi((input) => {
      paths.push(String(input));
      return Promise.resolve(
        jsonResponse(200, {
          totals: [],
          model_totals: [],
          daily: [],
          user_hourly: [],
          model_daily: [],
          model_hourly: [],
        }),
      );
    });
    await api.rollups();
    await api.rollups({ days: 8, hours: 8 * 24 });
    await api.rollups({ days: 8, hours: 8 * 24, teamId: "team-1" });
    await api.rollups({ teamId: "unassigned" });
    expect(paths).toEqual([
      "/rollups",
      "/rollups?days=8&hours=192",
      "/rollups?days=8&hours=192&team_id=team-1",
      "/rollups?team_id=unassigned",
    ]);
  });

  test("non-2xx responses raise ApiError carrying the status", async () => {
    const api = createApi(() => Promise.resolve(jsonResponse(503, {})));
    try {
      await api.listSessions();
      throw new Error("expected listSessions to reject");
    } catch (e) {
      expect(e instanceof ApiError).toBe(true);
      expect((e as ApiError).status).toBe(503);
    }
  });
});

describe("createAdminApi", () => {
  type Call = { path: string; init?: RequestInit };
  const recordingApi = (
    status: number,
    body: unknown,
  ): { api: ReturnType<typeof createAdminApi>; calls: Call[] } => {
    const calls: Call[] = [];
    const api = createAdminApi(
      () => "sec",
      (input, init) => {
        calls.push({ path: String(input), init });
        return Promise.resolve(jsonResponse(status, body));
      },
    );
    return { api, calls };
  };

  test("every request carries the admin bearer header", async () => {
    const { api, calls } = recordingApi(200, {
      users: [
        {
          name: "bob",
          email: null,
          disabled: false,
          created_at: "t",
          active_tokens: 2,
        },
      ],
    });
    const users = await api.users();
    expect(calls[0]!.path).toBe("/admin/users");
    expect(
      (calls[0]!.init?.headers as Record<string, string>).authorization,
    ).toBe("Bearer sec");
    expect(users[0]!.name).toBe("bob");
    expect(users[0]!.active_tokens).toBe(2);
  });

  test("audit builds the filtered, paginated query and unwraps rows+total", async () => {
    const { api, calls } = recordingApi(200, {
      rows: [
        {
          seq: 3,
          occurred_at: "2026-09-16T00:00:00.000Z",
          actor_kind: "user",
          actor_user: "guohua",
          action: "user.update",
          target: "bob",
          detail: { changes: { role: { before: "member", after: "admin" } } },
        },
      ],
      total: 42,
    });
    const page = await api.audit({
      limit: 50,
      offset: 50,
      kind: "user",
      actor: "guohua",
    });
    expect(calls[0]!.path).toBe(
      "/admin/audit?limit=50&offset=50&kind=user&actor=guohua",
    );
    expect(page.total).toBe(42);
    expect(page.rows[0]!.action).toBe("user.update");

    const bare = recordingApi(200, { rows: [], total: 0 });
    await bare.api.audit();
    expect(bare.calls[0]!.path).toBe("/admin/audit");
  });

  test("createUser POSTs a JSON body and unwraps the user", async () => {
    const { api, calls } = recordingApi(201, {
      user: {
        name: "bob",
        email: null,
        disabled: false,
        created_at: "t",
        active_tokens: 0,
      },
    });
    const user = await api.createUser("bob", null);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBe(
      JSON.stringify({ name: "bob", email: null }),
    );
    expect(user.name).toBe("bob");
  });

  test("setUserDisabled PATCHes the disabled flag", async () => {
    const { api, calls } = recordingApi(200, {
      user: {
        name: "bob",
        email: null,
        disabled: true,
        created_at: "t",
        active_tokens: 0,
      },
    });
    await api.setUserDisabled("bob", true);
    expect(calls[0]!.path).toBe("/admin/users/bob");
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ disabled: true }));
  });

  test("deleteUser and revokeToken issue DELETEs", async () => {
    const { api, calls } = recordingApi(200, { ok: true });
    await api.deleteUser("bob");
    await api.revokeToken("tid-1");
    expect(calls[0]!.path).toBe("/admin/users/bob");
    expect(calls[0]!.init?.method).toBe("DELETE");
    expect(calls[1]!.path).toBe("/admin/tokens/tid-1");
    expect(calls[1]!.init?.method).toBe("DELETE");
  });

  test("deleteSession DELETEs the encoded admin session path", async () => {
    const { api, calls } = recordingApi(200, { ok: true });
    await api.deleteSession("sess_leak 1");
    expect(calls[0]!.path).toBe("/admin/sessions/sess_leak%201");
    expect(calls[0]!.init?.method).toBe("DELETE");
  });

  test("mintToken POSTs the label and returns the plaintext exactly once", async () => {
    const { api, calls } = recordingApi(201, {
      token_id: "tid-1",
      hint: "sw_71a0d6d",
      token: "sw_fullsecret",
      label: "ci",
    });
    const minted = await api.mintToken("bob", "ci");
    expect(calls[0]!.path).toBe("/admin/users/bob/tokens");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body)).label).toBe("ci");
    expect(minted.token).toBe("sw_fullsecret");
  });

  test("mintToken without a label sends null", async () => {
    const { api, calls } = recordingApi(201, {
      token_id: "tid-1",
      hint: "sw_71a0d6d",
      token: "sw_fullsecret",
      label: null,
    });
    await api.mintToken("bob");
    expect(JSON.parse(String(calls[0]!.init?.body)).label).toBeNull();
  });

  test("tokens and health unwrap their payloads", async () => {
    const { api, calls } = recordingApi(200, {
      tokens: [
        {
          token_id: "tid-1",
          hint: "sw_71a0d6d",
          label: null,
          created_at: "t",
          revoked_at: null,
        },
      ],
    });
    const tokens = await api.tokens("bob");
    expect(calls[0]!.path).toBe("/admin/users/bob/tokens");
    expect(tokens[0]!.token_id).toBe("tid-1");

    const healthApi = recordingApi(200, {
      ok: true,
      sessions: 9,
      events: 1257,
      last_event_at: null,
    });
    const health = await healthApi.api.health();
    expect(healthApi.calls[0]!.path).toBe("/admin/health");
    expect(health.sessions).toBe(9);
  });

  test("401 raises ApiError carrying the status", async () => {
    const { api } = recordingApi(401, { error: "unauthorized" });
    try {
      await api.users();
      throw new Error("expected users() to reject");
    } catch (e) {
      expect(e instanceof ApiError).toBe(true);
      expect((e as ApiError).status).toBe(401);
    }
  });
});

describe("createReviewApi", () => {
  const reviewRow = {
    session_id: "sess_1",
    reviewer_id: "dri",
    reviewed_at: "2026-09-10T00:00:00.000Z",
  };

  test("reads are org-wide: no authorization header without a token", async () => {
    const headers: (string | null)[] = [];
    const api = createReviewApi(
      () => null,
      (input, init) => {
        headers.push(new Headers(init?.headers).get("authorization"));
        return Promise.resolve(jsonResponse(200, { review: reviewRow }));
      },
    );
    expect(await api.review("sess_1")).toEqual(reviewRow);
    expect(headers[0]).toBeNull();
  });

  test("markReviewed POSTs with the bearer token and unwraps the review", async () => {
    const calls: { path: string; method: string; auth: string | null }[] = [];
    const api = createReviewApi(
      () => "sw_tok",
      (input, init) => {
        calls.push({
          path: String(input),
          method: init?.method ?? "GET",
          auth: new Headers(init?.headers).get("authorization"),
        });
        return Promise.resolve(jsonResponse(200, { review: reviewRow }));
      },
    );
    expect(await api.markReviewed("sess_a b")).toEqual(reviewRow);
    expect(calls).toEqual([
      {
        path: "/sessions/sess_a%20b/review",
        method: "POST",
        auth: "Bearer sw_tok",
      },
    ]);
  });

  test("unmarkReviewed tolerates the 204 no-body response", async () => {
    const api = createReviewApi(
      () => "sw_tok",
      (_input, init) =>
        Promise.resolve(new Response(null, { status: 204, ...init })),
    );
    await expect(api.unmarkReviewed("sess_1")).resolves.toBeUndefined();
  });

  test("a 403 from the server surfaces as ApiError with the method", async () => {
    const api = createReviewApi(
      () => "sw_tok",
      () => Promise.resolve(jsonResponse(403, { error: "only a DRI" })),
    );
    try {
      await api.markReviewed("sess_1");
      throw new Error("expected markReviewed to reject");
    } catch (e) {
      expect(e instanceof ApiError).toBe(true);
      expect((e as ApiError).status).toBe(403);
      expect((e as ApiError).method).toBe("POST");
    }
  });

  test("addComment posts turn scope and body, returns the stored comment", async () => {
    const bodies: unknown[] = [];
    const comment = {
      comment_id: 7,
      session_id: "sess_1",
      turn_id: "turn_1",
      author_id: "alice",
      body: "looped twice",
      created_at: "2026-09-10T00:00:00.000Z",
    };
    const api = createReviewApi(
      () => "sw_tok",
      (input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(jsonResponse(201, { comment }));
      },
    );
    expect(await api.addComment("sess_1", "turn_1", "looped twice")).toEqual(
      comment,
    );
    expect(bodies).toEqual([{ turn_id: "turn_1", body: "looped twice" }]);
  });

  test("deleteComment DELETEs the note under the reader's bearer", async () => {
    const calls: { path: string; method: string }[] = [];
    const api = createReviewApi(
      () => "sw_tok",
      (input, init) => {
        calls.push({ path: String(input), method: String(init?.method) });
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    );
    await expect(api.deleteComment("sess_a b", 7)).resolves.toBeUndefined();
    expect(calls).toEqual([
      { path: "/sessions/sess_a%20b/comments/7", method: "DELETE" },
    ]);
  });

  test("me() reports the token's user, role, and own usage", async () => {
    const me: MeInfo = {
      user: "dri",
      role: "admin",
      email: "dri@corp.dev",
      team_name: "platform",
      is_dri: true,
      password_set: false,
      created_at: "2026-09-01T00:00:00.000Z",
      llm: null,
      usage: {
        sessions: 3,
        first_seen_at: null,
        last_seen_at: null,
        turns: 12,
        tool_calls: 40,
        model_totals: [],
      },
    };
    const api = createReviewApi(
      () => "sw_tok",
      () => Promise.resolve(jsonResponse(200, me)),
    );
    expect(await api.me()).toEqual(me);
  });
});

describe("ApiError", () => {
  test("carries the server's error reason when the body has one", async () => {
    const api = createReviewApi(
      () => "sw_tok",
      () =>
        Promise.resolve(
          jsonResponse(403, { error: "the admin role is required" }),
        ),
    );
    const err = await api.me().then(
      () => {
        throw new Error("expected rejection");
      },
      (e: Error) => e,
    );
    expect(err.message).toBe(
      "GET /me failed with 403 — the admin role is required",
    );
  });

  test("falls back to status-only when the body is not JSON", async () => {
    const api = createReviewApi(
      () => "sw_tok",
      () => Promise.resolve(new Response("nope", { status: 500 })),
    );
    const err = await api.me().then(
      () => {
        throw new Error("expected rejection");
      },
      (e: Error) => e,
    );
    expect(err.message).toBe("GET /me failed with 500");
  });
});

describe("createAdminApi.setUserRole", () => {
  test("PATCHes role under the admin bearer", async () => {
    const calls: { path: string; method: string; body: unknown }[] = [];
    const api = createAdminApi(
      () => "adm",
      (input, init) => {
        calls.push({
          path: String(input),
          method: init?.method ?? "GET",
          body: JSON.parse(String(init?.body)),
        });
        return Promise.resolve(jsonResponse(200, { ok: true }));
      },
    );
    await api.setUserRole("alice", "admin");
    expect(calls).toEqual([
      { path: "/admin/users/alice", method: "PATCH", body: { role: "admin" } },
    ]);
  });
});

describe("createAdminApi.setUserDri", () => {
  test("PATCHes is_dri under the admin bearer", async () => {
    const calls: { path: string; method: string; body: unknown }[] = [];
    const api = createAdminApi(
      () => "adm",
      (input, init) => {
        calls.push({
          path: String(input),
          method: init?.method ?? "GET",
          body: JSON.parse(String(init?.body)),
        });
        return Promise.resolve(jsonResponse(200, { ok: true }));
      },
    );
    await api.setUserDri("alice", true);
    expect(calls).toEqual([
      { path: "/admin/users/alice", method: "PATCH", body: { is_dri: true } },
    ]);
  });
});
