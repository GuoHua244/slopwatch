import { describe, expect, test } from "bun:test";
import type { StoredEvent } from "../api";
import { modelBreakdown, sessionTotals } from "./aggregate";
import { estimateCost, priceFor } from "./pricing";

const request = (
  model: string,
  usage?: Record<string, number>,
  duration = 100,
): StoredEvent => ({
  event_seq: 1,
  event: {
    schema_version: 1,
    agent: "zcode",
    session_id: "sess_t",
    occurred_at: "2026-09-09T15:27:00.000Z",
    kind: "model_request",
    provider: "builtin:test",
    model,
    duration_ms: duration,
    usage,
  },
});

describe("pricing", () => {
  test("exact model match wins", () => {
    expect(priceFor("GLM-5.3-Flash")?.input).toBe(0.15);
  });

  test("prefix match falls back to the family entry", () => {
    expect(priceFor("GLM-5.3-Flash-turbo")?.input).toBe(0.15);
    expect(priceFor("GLM-5.3")?.input).toBe(1.4);
  });

  test("unknown models have no price", () => {
    expect(priceFor("mystery-model")).toBeNull();
  });

  test("estimateCost applies per-million rates to each counter", () => {
    const price = priceFor("GLM-5.3-Flash")!;
    const cost = estimateCost(
      {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        cache_read_tokens: 500_000,
      },
      price,
    );
    expect(cost).toBeCloseTo(0.15 + 0.05 + 0.015, 10);
  });
});

describe("modelBreakdown", () => {
  test("groups by model and sums requests, duration, and tokens", () => {
    const events: StoredEvent[] = [
      request("GLM-5.3-Flash", { input_tokens: 100, output_tokens: 10 }, 1000),
      request(
        "GLM-5.3-Flash",
        { input_tokens: 50, output_tokens: 5, cache_read_tokens: 200 },
        500,
      ),
      request("mystery", { input_tokens: 7, output_tokens: 7 }, 42),
    ];
    const rows = modelBreakdown(events);
    expect(rows).toHaveLength(2);
    const flash = rows.find((r) => r.model === "GLM-5.3-Flash")!;
    expect(flash.requests).toBe(2);
    expect(flash.durationMs).toBe(1500);
    expect(flash.inputTokens).toBe(150);
    expect(flash.cacheReadTokens).toBe(200);
    expect(flash.costUsd).not.toBeNull();
    const mystery = rows.find((r) => r.model === "mystery")!;
    expect(mystery.costUsd).toBeNull();
  });

  test("ignores non-request events", () => {
    const events: StoredEvent[] = [
      request("GLM-5.3-Flash", { input_tokens: 1 }),
      {
        event_seq: 2,
        event: {
          schema_version: 1,
          agent: "zcode",
          session_id: "sess_t",
          occurred_at: "2026-09-09T15:27:00.000Z",
          kind: "session",
          event: "start",
          cwd: "D:\\x",
          hostname: "H",
        },
      },
    ];
    expect(modelBreakdown(events)).toHaveLength(1);
  });
});

describe("sessionTotals", () => {
  test("sums every request; cost is null when any model is unpriced", () => {
    const events: StoredEvent[] = [
      request("GLM-5.3-Flash", { input_tokens: 1_000_000, output_tokens: 10 }),
      request("mystery", { input_tokens: 5 }),
    ];
    const totals = sessionTotals(events);
    expect(totals.requests).toBe(2);
    expect(totals.inputTokens).toBe(1_000_005);
    expect(totals.costUsd).toBeNull();
  });

  test("cost is a number when every model has a price", () => {
    const totals = sessionTotals([
      request("GLM-5.3-Flash", {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
    ]);
    expect(totals.costUsd).toBeCloseTo(0.65, 10);
  });

  test("an empty session has zero everything and null cost", () => {
    expect(sessionTotals([])).toEqual({
      requests: 0,
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
    });
  });
});
