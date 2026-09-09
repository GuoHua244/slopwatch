import { describe, expect, test } from "bun:test";
import type { NormalEvent } from "@slopwatch/events";
import {
  ApiError,
  createAdminApi,
  createApi,
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
  last_seq: 3,
  title: "hello",
  task_preview: null,
  total_input_tokens: 100,
  total_output_tokens: 50,
  total_cache_read_tokens: 10,
  total_cache_write_tokens: 0,
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

  test("mintToken POSTs and returns the plaintext exactly once", async () => {
    const { api, calls } = recordingApi(201, {
      token_id: "tid-1",
      hint: "sw_71a0d6d",
      token: "sw_fullsecret",
    });
    const minted = await api.mintToken("bob");
    expect(calls[0]!.path).toBe("/admin/users/bob/tokens");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(minted.token).toBe("sw_fullsecret");
  });

  test("tokens and health unwrap their payloads", async () => {
    const { api, calls } = recordingApi(200, {
      tokens: [
        {
          token_id: "tid-1",
          hint: "sw_71a0d6d",
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
