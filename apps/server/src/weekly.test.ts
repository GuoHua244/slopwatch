import { describe, expect, test } from "bun:test";
import type { DailyRollupRow } from "./store";
import { weekWindow, weeklyUserTable } from "./weekly";

describe("weekWindow (v3 decision 36)", () => {
  test("the window is the trailing 7 UTC days ending yesterday", () => {
    const w = weekWindow(new Date("2026-11-20T15:30:00Z"));
    // [since, until): 11-13 .. 11-20 — 11-20 (today) excluded, 11-19 last.
    expect(w.sinceDay).toBe("2026-11-13");
    expect(w.untilDay).toBe("2026-11-20");
    expect(w.prevSinceDay).toBe("2026-11-06");
    expect(w.prevUntilDay).toBe("2026-11-13");
  });

  test("running twice on the same day gives the same window", () => {
    const a = weekWindow(new Date("2026-11-20T00:01:00Z"));
    const b = weekWindow(new Date("2026-11-20T23:59:00Z"));
    expect(a).toEqual(b);
  });
});

describe("weeklyUserTable", () => {
  const day = (
    userId: string,
    d: string,
    turns: number,
    toolCalls: number,
    failed: number,
    repeated: number,
  ): DailyRollupRow => ({
    user_id: userId,
    day: d,
    turns,
    tool_calls: toolCalls,
    failed_tool_calls: failed,
    repeated_calls: repeated,
  });

  test("sums a user's daily rows into one per-week figure", () => {
    const table = weeklyUserTable({
      daily: [
        day("alice", "2026-11-13", 1, 10, 1, 1),
        day("alice", "2026-11-14", 2, 10, 2, 0),
        day("alice", "2026-11-06", 3, 20, 5, 5),
        day("bob", "2026-11-15", 1, 4, 0, 0),
      ],
      sinceDay: "2026-11-13",
      untilDay: "2026-11-20",
      prevSinceDay: "2026-11-06",
      prevUntilDay: "2026-11-13",
    });
    const rows = table.split("\n");
    expect(rows).toHaveLength(4);
    expect(rows[2]).toContain("alice | 3/3 | 20/20 | 20.0% | 50.0%");
    expect(rows[3]).toContain("bob | 1/0 | 4/0 | 0.0% | —");
  });
});

// --- Postgres-backed end-to-end: seed two weeks, generate with a fake LLM ---

const dbTests = () =>
  (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL) !== undefined;
const testDsn = () =>
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!;

describe.skipIf(!dbTests())("weekly report generation", () => {
  let store: import("./store").Store | undefined;
  const ensure = async () => {
    if (store) return;
    const { createPgStore } = await import("./store");
    store = createPgStore(testDsn());
    await store.migrate();
  };

  const NOW = new Date("2026-11-20T12:00:00Z");

  test("generate assembles the week, calls the LLM once, stores the row", async () => {
    await ensure();
    const user = `weekly-${crypto.randomUUID().slice(0, 8)}`;
    const sid = `sess_weekly-${crypto.randomUUID().slice(0, 8)}`;
    await store!.createUser(user, null);
    await store!.setLlmConfig(user, {
      endpoint: "https://llm.example/v1/chat/completions",
      model: "test-model",
      apiKey: "sk-test",
    });
    // Activity inside the current window (11-19 is yesterday).
    await store!.appendEvents(
      [
        {
          schema_version: 1,
          agent: "zcode",
          session_id: sid,
          occurred_at: "2026-11-19T09:00:00Z",
          kind: "session",
          event: "start",
          cwd: "D:\\demo",
          hostname: "DEV-01",
        },
        {
          schema_version: 1,
          agent: "zcode",
          session_id: sid,
          occurred_at: "2026-11-19T09:01:00Z",
          kind: "turn",
          event: "start",
          turn_id: "t1",
        },
        {
          schema_version: 1,
          agent: "zcode",
          session_id: sid,
          occurred_at: "2026-11-19T09:02:00Z",
          kind: "model_request",
          provider: "p",
          model: "m1",
          duration_ms: 5,
          usage: { input_tokens: 900, output_tokens: 100 },
        },
        {
          schema_version: 1,
          agent: "zcode",
          session_id: sid,
          occurred_at: "2026-11-19T09:03:00Z",
          kind: "tool",
          event: "call",
          tool_call_id: "c1",
          tool: "Bash",
          args: { command: 'git commit -m "ship the weekly fix"' },
        },
      ],
      user,
    );

    let llmCalls = 0;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      llmCalls += 1;
      const body = JSON.parse(String(init?.body)) as {
        messages: { role: string; content: string }[];
      };
      const prompt =
        body.messages.find((m) => m.role === "user")?.content ?? "";
      // The prompt carries the assembled data: window, tables, commit.
      expect(prompt).toContain("Report window: 2026-11-13 .. 2026-11-20");
      expect(prompt).toContain(user);
      expect(prompt).toContain("ship the weekly fix");
      expect(prompt).toContain("m1");
      return Response.json({
        choices: [{ message: { content: "# Weekly report\nAll quiet." } }],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 80,
          prompt_tokens_details: { cached_tokens: 900 },
        },
      });
    }) as typeof fetch;

    const { createWeeklyRunner } = await import("./weekly");
    const runner = createWeeklyRunner(store!, {
      fetchImpl,
      now: () => NOW,
    });
    const report = await runner.generate(user);
    expect(llmCalls).toBe(1);
    expect(report.status, report.error ?? "ok").toBe("completed");
    expect(report.model).toBe("test-model");
    expect(report.result).toContain("All quiet.");
    expect(report.input_tokens).toBe(1200);
    expect(report.output_tokens).toBe(80);
    expect(report.cache_read_tokens).toBe(900);
    expect(report.since_day).toBe("2026-11-13");
    expect(report.until_day).toBe("2026-11-20");

    // The stored list carries it.
    const list = await store!.listWeeklyReports(20);
    expect(list.find((r) => r.id === report.id)).toBeDefined();
    await store!.clearLlmConfig(user);
  });

  test("a requester without LLM credentials gets a failed row with the fix", async () => {
    await ensure();
    const user = `weekly-${crypto.randomUUID().slice(0, 8)}`;
    const { createWeeklyRunner } = await import("./weekly");
    const runner = createWeeklyRunner(store!, { now: () => NOW });
    const report = await runner.generate(user);
    expect(report.status).toBe("failed");
    expect(report.error).toContain("no LLM credentials");
    expect(report.result).toBeNull();
  });

  test("cleanup", async () => {
    if (store) await store.close();
  });
});
