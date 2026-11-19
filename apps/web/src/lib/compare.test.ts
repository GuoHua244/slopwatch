import { describe, expect, test } from "bun:test";
import type { ModelRollupRow } from "../api";
import { modelStats, modelsInWindow } from "./compare";

// Fixed "now": 2026-09-12T10:00Z, so the daily series spans 09-04..09-12
// for a 9-day window and 09-10..09-12 for 3 days.
const NOW = new Date("2026-09-12T10:00:00Z");

const row = (
  user: string,
  bucket: string,
  model: string,
  requests: number,
  input: number,
  output: number,
): ModelRollupRow => ({
  user_id: user,
  bucket,
  model,
  model_requests: requests,
  input_tokens: input,
  output_tokens: output,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
});

const PRICED = "priced-model";
const UNKNOWN = "mystery-model";

describe("modelStats (v3 decision 35)", () => {
  test("aggregates rows across users into one model's window stats", () => {
    const stats = modelStats(
      [
        row("alice", "2026-09-11", PRICED, 6, 300, 110),
        row("bob", "2026-09-11", PRICED, 4, 100, 40),
        row("alice", "2026-09-10", PRICED, 2, 50, 20),
        row("alice", "2026-09-11", "other", 1, 10, 5),
      ],
      PRICED,
      3,
      NOW,
    );
    expect(stats).not.toBeNull();
    expect(stats!.requests).toBe(12);
    expect(stats!.inputTokens).toBe(450);
    expect(stats!.outputTokens).toBe(170);
    expect(stats!.totalTokens).toBe(620);
    // 620 tokens over 12 requests.
    expect(stats!.tokensPerRequest).toBeCloseTo(620 / 12);
    // Window 3d ends 09-12: 09-10 (70), 09-11 (550), 09-12 (0).
    expect(stats!.daily).toEqual([70, 550, 0]);
  });

  test("null stats for a model the window never saw", () => {
    expect(
      modelStats([row("a", "2026-09-11", PRICED, 1, 1, 1)], UNKNOWN, 3, NOW),
    ).toBeNull();
  });

  test("an unpriced model shows dashes for cost, not a wrong number", () => {
    const stats = modelStats(
      [row("alice", "2026-09-11", UNKNOWN, 3, 100, 50)],
      UNKNOWN,
      2,
      NOW,
    );
    expect(stats!.costUsd).toBeNull();
  });

  test("absent days are zero, oldest → newest, UTC days", () => {
    const stats = modelStats(
      [row("alice", "2026-09-10", PRICED, 1, 10, 5)],
      PRICED,
      4,
      NOW,
    );
    // Window 4d ends 09-12: 09-09 (0), 09-10 (15), 09-11 (0), 09-12 (0).
    expect(stats!.daily).toEqual([0, 15, 0, 0]);
  });
});

describe("modelsInWindow", () => {
  test("heaviest model first, alphabetical tiebreak", () => {
    expect(
      modelsInWindow([
        row("a", "2026-09-11", "zeta", 1, 1, 1),
        row("a", "2026-09-11", "alpha", 5, 1, 1),
        row("b", "2026-09-11", "alpha", 2, 1, 1),
      ]),
    ).toEqual(["alpha", "zeta"]);
  });
});
