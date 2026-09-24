import { describe, expect, test } from "bun:test";
import { createRetroQueue } from "./retrospective/queue";
import type { RetroRow, Store } from "./store";

/**
 * Queue tests run against a scripted store slice and a scripted fetch, so
 * every LLM outcome (content, provider error, reasoning budget blown) is
 * deterministic. Only the methods the runner touches are live; the rest of
 * the Store surface is unreachable from the queue.
 */
const scriptedStore = (
  overrides: {
    retro?: Partial<RetroRow>;
    llm?: { endpoint: string; model: string; apiKey: string } | null;
    session?: { session_id: string } | null;
  } = {},
) => {
  const calls: string[] = [];
  const base: RetroRow = {
    id: 7,
    session_id: "s1",
    user_id: "alice",
    angle: "efficiency",
    supplement: null,
    system_snapshot: "system prompt",
    prompt_snapshot: "user prompt",
    status: "pending",
    result: null,
    model: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    reasoning_tokens: null,
    error: null,
    created_at: "2026-09-25T00:00:00.000Z",
    started_at: null,
    finished_at: null,
  };
  const store = {
    getRetro: async (id: number) => {
      calls.push(`getRetro:${id}`);
      return { ...base, ...overrides.retro } as RetroRow;
    },
    setRetroRunning: async (id: number) => {
      calls.push(`running:${id}`);
    },
    getLlmConfig: async () => {
      calls.push("llm");
      return overrides.llm === undefined
        ? {
            endpoint: "http://llm.test/v1",
            model: "test-model",
            apiKey: "sk-x",
          }
        : overrides.llm;
    },
    getSession: async () =>
      overrides.session === undefined
        ? { session_id: "s1" }
        : overrides.session,
    setRetroCompleted: async (
      id: number,
      patch: {
        result: string;
        model: string;
        usage?: Record<string, number | undefined>;
      },
    ) => {
      calls.push(
        `completed:${id}:${patch.model}:${patch.usage?.inputTokens ?? "-"}`,
      );
    },
    setRetroFailed: async (id: number, error: string) => {
      calls.push(`failed:${id}:${error}`);
    },
  };
  return { calls, store: store as unknown as Store };
};

const llmResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const answerBody = (content: string, usage: Record<string, number> = {}) => ({
  choices: [{ message: { content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 50, ...usage },
});

const drain = async (): Promise<void> => {
  // the pump settles within a few microtask/macrotask turns
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
};

describe("retrospective queue", () => {
  test("a pending row runs to completed with the model and usage recorded", async () => {
    const { calls, store } = scriptedStore();
    let fetches = 0;
    const queue = createRetroQueue(store, {
      fetchImpl: async () => {
        fetches += 1;
        return llmResponse(answerBody("# 复盘报告\n一切高效。"));
      },
    });
    queue.enqueue(7);
    await drain();
    expect(fetches).toBe(1);
    expect(calls).toContain("running:7");
    expect(calls.some((c) => c.startsWith("completed:7:test-model:100"))).toBe(
      true,
    );
  });

  test("a row that is no longer pending is left alone", async () => {
    const { calls, store } = scriptedStore({
      retro: { status: "failed", error: "already gone" },
    });
    const queue = createRetroQueue(store, {
      fetchImpl: async () => llmResponse(answerBody("x")),
    });
    queue.enqueue(7);
    await drain();
    expect(calls).toEqual(["getRetro:7"]);
  });

  test("removed LLM credentials fail the run with a fix-it message", async () => {
    const { calls, store } = scriptedStore({ llm: null });
    const queue = createRetroQueue(store, {
      fetchImpl: async () => llmResponse(answerBody("x")),
    });
    queue.enqueue(7);
    await drain();
    expect(calls.some((c) => c.includes("credentials were removed"))).toBe(
      true,
    );
  });

  test("a deleted session fails the run", async () => {
    const { calls, store } = scriptedStore({ session: null });
    const queue = createRetroQueue(store, {
      fetchImpl: async () => llmResponse(answerBody("x")),
    });
    queue.enqueue(7);
    await drain();
    expect(calls.some((c) => c.includes("session was deleted"))).toBe(true);
  });

  test("a provider error surfaces as the run's failure reason", async () => {
    const { calls, store } = scriptedStore();
    const queue = createRetroQueue(store, {
      fetchImpl: async () => llmResponse({ error: "quota" }, 401),
    });
    queue.enqueue(7);
    await drain();
    expect(calls.some((c) => c.includes("responded 401"))).toBe(true);
  });

  test("a reasoning-budget blowout retries once with a raised cap", async () => {
    const { calls, store } = scriptedStore();
    const bodies: unknown[] = [
      // first attempt: the whole 16k budget goes to reasoning, no content
      {
        choices: [{ message: { content: "" }, finish_reason: "length" }],
        usage: { prompt_tokens: 90_000, completion_tokens: 16_384 },
      },
      // retry at 4x: the report arrives
      {
        choices: [
          { message: { content: "# 复盘报告" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 90_000, completion_tokens: 3_000 },
      },
    ];
    let index = 0;
    const caps: unknown[] = [];
    const queue = createRetroQueue(store, {
      fetchImpl: async (_url, init) => {
        caps.push(JSON.parse(String(init?.body)).max_tokens);
        return llmResponse(bodies[index++]!);
      },
    });
    queue.enqueue(7);
    await drain();
    expect(caps).toEqual([16_384, 65_536]);
    expect(calls.some((c) => c.startsWith("completed:7"))).toBe(true);
  });

  test("an empty answer after the retry fails the run with the finish reason", async () => {
    const { calls, store } = scriptedStore();
    const queue = createRetroQueue(store, {
      fetchImpl: async () =>
        llmResponse({
          choices: [{ message: { content: "" }, finish_reason: "length" }],
          usage: { prompt_tokens: 1, completion_tokens: 2 },
        }),
    });
    queue.enqueue(7);
    await drain();
    expect(calls.some((c) => c.includes("finish_reason length"))).toBe(true);
  });
});
