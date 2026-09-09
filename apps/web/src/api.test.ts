import { describe, expect, test } from "bun:test";
import type { NormalEvent } from "@slopwatch/events";
import { ApiError, createApi, type SessionSummary } from "./api";

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
