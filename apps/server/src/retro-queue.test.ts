import { describe, expect, test } from "bun:test";
import { SCHEMA_VERSION, type SessionStartEvent } from "@slopwatch/events";
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
    phase: null,
    output_chars: null,
    output_tail: null,
    heartbeat_at: null,
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
    setRetroProgress: async (
      id: number,
      phase: string,
      outputChars: number,
      tail: string | null,
    ) => {
      calls.push(`progress:${id}:${phase}:${outputChars}:${tail ?? "-"}`);
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

describe("retrospective queue streaming progress", () => {
  type Delta = { content?: string; reasoning_content?: string };
  const frame = (delta: Delta): string =>
    `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;

  /** An SSE Response whose body is the given frames, closed immediately. */
  const sse = (frames: string[]): Response => {
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const f of frames) controller.enqueue(enc.encode(f));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  };

  test("a streaming run records waiting_first_byte, then the first byte, and throttles the chunk burst", async () => {
    const { calls, store } = scriptedStore();
    // A burst of frames inside the throttle window: the counter must be
    // visible without the DB seeing one UPDATE per frame.
    const frames = [
      frame({ reasoning_content: "thinking" }),
      ...Array.from({ length: 40 }, (_, i) => frame({ content: `c${i}` })),
    ];
    const queue = createRetroQueue(store, {
      fetchImpl: async () => sse(frames),
    });
    queue.enqueue(7);
    await drain();
    const waiting = calls.indexOf("progress:7:waiting_first_byte:0:-");
    const streaming = calls.filter((c) => c.startsWith("progress:7:streaming"));
    expect(waiting).toBeGreaterThan(-1);
    expect(waiting).toBeGreaterThan(calls.indexOf("running:7"));
    expect(streaming).toEqual(["progress:7:streaming:0:-"]);
    expect(calls.indexOf("progress:7:streaming:0:-")).toBeGreaterThan(waiting);
    expect(calls.some((c) => c.startsWith("completed:7"))).toBe(true);
  });

  test("a classic JSON answer never claims streaming progress", async () => {
    const { calls, store } = scriptedStore();
    const queue = createRetroQueue(store, {
      fetchImpl: async () => llmResponse(answerBody("done")),
    });
    queue.enqueue(7);
    await drain();
    expect(calls).toContain("progress:7:waiting_first_byte:0:-");
    expect(calls.some((c) => c.startsWith("progress:7:streaming"))).toBe(false);
  });

  test("a throttled chunk write past the interval carries the rolling tail", async () => {
    const { calls, store } = scriptedStore();
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        // two frames inside the throttle window, then one past it
        controller.enqueue(
          enc.encode(frame({ reasoning_content: "thinking" })),
        );
        controller.enqueue(enc.encode(frame({ content: "He" })));
        await new Promise((r) => setTimeout(r, 40));
        controller.enqueue(enc.encode(frame({ content: "llo" })));
        controller.close();
      },
    });
    const queue = createRetroQueue(store, {
      progressIntervalMs: 10,
      fetchImpl: async () =>
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
    });
    queue.enqueue(7);
    await drain();
    // the first-byte write carries no tail; the post-interval chunk write
    // persists the combined rolling tail (reasoning + content)
    expect(calls).toContain("progress:7:streaming:0:-");
    expect(calls).toContain("progress:7:streaming:13:thinkingHello");
  });
});

// --- DB-backed store semantics (require DATABASE_URL_TEST / DATABASE_URL) ---

const dbTests = () =>
  (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL) !== undefined;
const testDsn = () =>
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!;

describe.skipIf(!dbTests())("retrospective progress against Postgres", () => {
  let store: Store | undefined;
  const ensure = async () => {
    if (store) return;
    const { createPgStore } = await import("./store");
    store = createPgStore(testDsn());
    await store.migrate();
  };

  const startEvent = (sessionId: string): SessionStartEvent => ({
    schema_version: SCHEMA_VERSION,
    agent: "zcode",
    session_id: sessionId,
    occurred_at: new Date().toISOString(),
    kind: "session",
    event: "start",
    cwd: "D:\\demo",
    hostname: "DEV-01",
  });

  const openRetro = async (sessionId: string) => {
    await store!.appendEvents([startEvent(sessionId)], "alice");
    const retro = await store!.createRetro({
      sessionId,
      userId: "alice",
      angle: "efficiency",
      supplement: null,
      systemSnapshot: "system",
      promptSnapshot: "prompt",
    });
    await store!.setRetroRunning(retro.id);
    return retro.id;
  };

  test("progress writes land on a running row and a late one cannot resurrect it", async () => {
    await ensure();
    const sessionId = `sess_retroprog-${crypto.randomUUID().slice(0, 8)}`;
    const id = await openRetro(sessionId);

    await store!.setRetroProgress(id, "waiting_first_byte", 0, null);
    await store!.setRetroProgress(id, "streaming", 1234, "报告的尾巴文本");
    const running = await store!.getRetro(id);
    expect(running!.status).toBe("running");
    expect(running!.phase).toBe("streaming");
    expect(running!.output_chars).toBe(1234);
    expect(running!.output_tail).toBe("报告的尾巴文本");
    expect(running!.heartbeat_at).not.toBeNull();

    await store!.setRetroCompleted(id, {
      result: "report",
      model: "test-model",
    });
    // The run finished while a throttled write was still in flight — the
    // status guard turns it into a no-op instead of a fake progress line.
    await store!.setRetroProgress(id, "streaming", 9999, "late");
    const done = await store!.getRetro(id);
    expect(done!.status).toBe("completed");
    expect(done!.phase).toBeNull();
    expect(done!.output_chars).toBeNull();
    expect(done!.output_tail).toBeNull();
    expect(done!.heartbeat_at).toBeNull();

    await store!.deleteSession(sessionId);
  });

  test("a failed run clears its progress columns", async () => {
    await ensure();
    const sessionId = `sess_retroprog-${crypto.randomUUID().slice(0, 8)}`;
    const id = await openRetro(sessionId);

    await store!.setRetroProgress(id, "streaming", 500, "half a tail");
    await store!.setRetroFailed(id, "the endpoint hung");
    const failed = await store!.getRetro(id);
    expect(failed!.status).toBe("failed");
    expect(failed!.phase).toBeNull();
    expect(failed!.output_chars).toBeNull();
    expect(failed!.output_tail).toBeNull();
    expect(failed!.heartbeat_at).toBeNull();

    await store!.deleteSession(sessionId);
  });
});
