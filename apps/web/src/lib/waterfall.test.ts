import { describe, expect, test } from "bun:test";
import type { ModelRequestEvent, TokenUsage } from "@slopwatch/events";
import type { TurnActivity } from "./timeline";
import { waterfallBars, waterfallTotal } from "./waterfall";

const turn = (
  turnId: string,
  usage?: TokenUsage,
  userMessage?: string,
): TurnActivity => ({
  turnId,
  ...(userMessage !== undefined ? { userMessage } : {}),
  ...(usage !== undefined ? { usage } : {}),
  modelRequests: [],
  tools: [],
});

const orphan = (usage: TokenUsage): ModelRequestEvent => ({
  schema_version: 1,
  agent: "zcode",
  session_id: "s1",
  occurred_at: "2026-09-11T17:00:00Z",
  kind: "model_request",
  provider: "p",
  model: "m1",
  duration_ms: 5,
  usage,
});

describe("waterfallBars", () => {
  test("one bar per turn with the four canonical kinds summed into total", () => {
    const bars = waterfallBars([
      turn("t1", {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 800,
        cache_write_tokens: 20,
      }),
      turn("t2", { input_tokens: 30, output_tokens: 10 }),
    ]);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({
      turnId: "t1",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 800,
      cacheWriteTokens: 20,
      total: 970,
    });
    expect(bars[1]).toMatchObject({ turnId: "t2", total: 40 });
  });

  test("a turn without usage still takes a bar, at zero", () => {
    const bars = waterfallBars([turn("t1"), turn("t2", { output_tokens: 5 })]);
    expect(bars[0]).toMatchObject({ turnId: "t1", total: 0 });
    expect(waterfallTotal(bars)).toBe(5);
  });

  test("the hover label prefers the user message, elided to one line", () => {
    const bars = waterfallBars([
      turn(
        "t1",
        { output_tokens: 1 },
        "fix the flaky auth test\n\nsecond line",
      ),
      turn("t2", { output_tokens: 1 }),
    ]);
    expect(bars[0]!.label).toBe("fix the flaky auth test second line");
    expect(bars[1]!.label).toBe("turn t2");
  });

  test("orphan requests close the strip as an unattributed bar", () => {
    const bars = waterfallBars(
      [turn("t1", { input_tokens: 10 })],
      [orphan({ input_tokens: 7, output_tokens: 3 })],
    );
    expect(bars).toHaveLength(2);
    expect(bars[1]).toMatchObject({
      turnId: "(unattributed)",
      inputTokens: 7,
      outputTokens: 3,
      total: 10,
    });
    expect(waterfallTotal(bars)).toBe(20);
  });

  test("zero-usage orphans produce no unattributed bar", () => {
    const bars = waterfallBars(
      [turn("t1", { output_tokens: 9 })],
      [orphan({})],
    );
    expect(bars).toHaveLength(1);
  });
});
