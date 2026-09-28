import { describe, expect, test } from "bun:test";
import { createApp, type App } from "./http";
import type { Store } from "./store";
import { createSummaryFold } from "./summary-fold";

// Decision 28 route/runner tests: the fold executes on the caller's own
// profile credentials (409 without them, 502 when the LLM fails), the key
// never reaches the client, and the caller's token budget is clamped.
const scriptedStore = (
  overrides: Partial<Record<string, unknown>> = {},
): Store =>
  ({
    resolveTokenUser: async () => null,
    roleOf: async () => "member" as const,
    getUser: async () => null,
    getLlmConfig: async () => null,
    ...overrides,
  }) as unknown as Store;

const appWith = (
  store: Store,
  summaryFold?: ReturnType<typeof createSummaryFold>,
): App =>
  createApp({ tokens: new Map([["tok-alice", "alice"]]), store, summaryFold });

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
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }),
  );

const foldBody = JSON.stringify({
  system: "fold system prompt",
  user: "PRIOR SUMMARY:\n(none)\n\nNEW ACTIVITY:\n- turn 1",
});

describe("summary fold routes", () => {
  test("401 without a token — both endpoints sit behind the read plane", async () => {
    const app = appWith(scriptedStore(), createSummaryFold(scriptedStore()));
    expect((await req(app, "/summary/llm")).status).toBe(401);
    expect((await req(app, "/summary/fold", { method: "POST" })).status).toBe(
      401,
    );
  });

  test("503 when the fold runner is absent (tests / stripped builds)", async () => {
    const app = appWith(scriptedStore());
    expect((await req(app, "/summary/llm", {}, "tok-alice")).status).toBe(503);
    expect(
      (await req(app, "/summary/fold", { method: "POST" }, "tok-alice")).status,
    ).toBe(503);
  });

  test("GET /summary/llm reports credential status, never the key", async () => {
    const store = scriptedStore();
    const app = appWith(store, createSummaryFold(store));
    expect(
      await (await req(app, "/summary/llm", {}, "tok-alice")).json(),
    ).toEqual({ configured: false });
    const configured = scriptedStore({
      getLlmConfig: async () => ({
        endpoint: "https://open.bigmodel.cn/api/coding/paas/v4",
        model: "glm-5.3-flash",
        apiKey: "sk-secret",
      }),
    });
    const app2 = appWith(configured, createSummaryFold(configured));
    expect(
      await (await req(app2, "/summary/llm", {}, "tok-alice")).json(),
    ).toEqual({ configured: true });
  });

  test("POST /summary/fold answers 409 without credentials", async () => {
    const app = appWith(scriptedStore(), createSummaryFold(scriptedStore()));
    const res = await req(
      app,
      "/summary/fold",
      { method: "POST", body: foldBody },
      "tok-alice",
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain(
      "your own LLM credentials",
    );
  });

  test("400 when the fold prompt is missing system or user", async () => {
    const store = scriptedStore({
      getLlmConfig: async () => ({
        endpoint: "https://llm.test/v1",
        model: "glm-5.3-flash",
        apiKey: "sk",
      }),
    });
    const app = appWith(store, createSummaryFold(store));
    expect(
      (
        await req(
          app,
          "/summary/fold",
          { method: "POST", body: JSON.stringify({ system: "s" }) },
          "tok-alice",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await req(
          app,
          "/summary/fold",
          { method: "POST", body: "not json" },
          "tok-alice",
        )
      ).status,
    ).toBe(400);
  });

  test("200 on success: the configured model executes and usage maps back", async () => {
    const seen: { auth?: string | null; maxTokens?: number } = {};
    const store = scriptedStore({
      getLlmConfig: async () => ({
        endpoint: "https://open.bigmodel.cn/api/coding/paas/v4",
        model: "glm-5.3-flash",
        apiKey: "sk-stored-key",
      }),
    });
    const runner = createSummaryFold(store, {
      fetchImpl: async (_url, init) => {
        seen.auth = new Headers(init?.headers).get("authorization");
        seen.maxTokens = (
          JSON.parse(String(init?.body)) as {
            max_tokens: number;
          }
        ).max_tokens;
        return Response.json({
          choices: [{ message: { content: "  Folded summary.  " } }],
          usage: {
            prompt_tokens: 500,
            completion_tokens: 120,
            prompt_tokens_details: { cached_tokens: 300 },
          },
        });
      },
    });
    const app = appWith(store, runner);
    const res = await req(
      app,
      "/summary/fold",
      { method: "POST", body: foldBody },
      "tok-alice",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      text: "Folded summary.",
      model: "glm-5.3-flash",
      usage: {
        input_tokens: 500,
        output_tokens: 120,
        cache_read_tokens: 300,
      },
    });
    // the executed call carries the stored key against the stored endpoint —
    // the caller's token never appears in the outbound authorization
    expect(seen.auth).toBe("Bearer sk-stored-key");
    expect(seen.maxTokens).toBe(4096);
  });

  test("502 with the failure reason when the LLM call fails", async () => {
    const store = scriptedStore({
      getLlmConfig: async () => ({
        endpoint: "https://llm.test/v1",
        model: "glm-5.3-flash",
        apiKey: "sk",
      }),
    });
    const runner = createSummaryFold(store, {
      fetchImpl: async () => Response.json({}, { status: 500 }),
    });
    const app = appWith(store, runner);
    const res = await req(
      app,
      "/summary/fold",
      { method: "POST", body: foldBody },
      "tok-alice",
    );
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain(
      "responded 500",
    );
  });

  test("the runner clamps the caller's token budget", async () => {
    const caps: number[] = [];
    const store = scriptedStore({
      getLlmConfig: async () => ({
        endpoint: "https://llm.test/v1",
        model: "m",
        apiKey: "sk",
      }),
    });
    const runner = createSummaryFold(store, {
      fetchImpl: async (_url, init) => {
        caps.push(
          (JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens,
        );
        return Response.json({
          choices: [{ message: { content: "ok" } }],
        });
      },
    });
    (await runner.run("alice", { system: "s", user: "u", maxTokens: 999_999 }))
      .ok;
    (await runner.run("alice", { system: "s", user: "u", maxTokens: -5 })).ok;
    expect(caps).toEqual([16_384, 1]);
  });
});
