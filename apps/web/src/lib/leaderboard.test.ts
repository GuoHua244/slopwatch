import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "../api";
import type { SessionStats } from "./leaderboard";
import { aggregateLeaderboard } from "./leaderboard";

export type Stats = { costUsd: number | null; turns: number; requests: number };

const session = (
  sessionId: string,
  userId: string | null,
  agent: string,
  firstSeenAt: string,
  outputTokens = 0,
): SessionSummary => ({
  session_id: sessionId,
  agent,
  user_id: userId,
  first_seen_at: firstSeenAt,
  last_seq: 1,
  title: null,
  task_preview: null,
  total_input_tokens: 10,
  total_output_tokens: outputTokens,
  total_cache_read_tokens: 0,
  total_cache_write_tokens: 0,
});

const stats = (
  costUsd: number | null,
  turns = 0,
  requests = 0,
  tokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
): SessionStats => ({ costUsd, turns, requests, ...tokens });

describe("aggregateLeaderboard", () => {
  test("groups by user and sums sessions, tokens, turns, requests", () => {
    const rows = aggregateLeaderboard(
      [
        session("s1", "alice", "zcode", "2026-09-09T10:00:00Z", 5),
        session("s2", "alice", "pi", "2026-09-09T11:00:00Z", 7),
        session("s3", "bob", "zcode", "2026-09-09T09:00:00Z", 1),
      ],
      new Map([
        [
          "s1",
          stats(1, 3, 4, {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
          }),
        ],
        [
          "s2",
          stats(2, 1, 2, {
            inputTokens: 200,
            outputTokens: 60,
            cacheReadTokens: 20,
          }),
        ],
        ["s3", stats(0.5, 1, 1)],
      ]),
    );
    expect(rows.map((r) => r.userId)).toEqual(["alice", "bob"]);
    const alice = rows[0]!;
    expect(alice.sessions).toBe(2);
    expect(alice.turns).toBe(4);
    expect(alice.requests).toBe(6);
    expect(alice.inputTokens).toBe(300);
    expect(alice.outputTokens).toBe(110);
    expect(alice.cacheReadTokens).toBe(30);
    expect(alice.costUsd).toBe(3);
    expect(alice.lastActiveAt).toBe("2026-09-09T11:00:00Z");
  });

  test("event-backed token sums replace the Server's token columns", () => {
    const rows = aggregateLeaderboard(
      [session("s1", "alice", "zcode", "2026-09-09T10:00:00Z", 5)],
      new Map([
        [
          "s1",
          stats(1, 1, 1, {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadTokens: 100,
          }),
        ],
      ]),
    );
    expect(rows[0]!.inputTokens).toBe(1000);
    expect(rows[0]!.outputTokens).toBe(500);
    expect(rows[0]!.cacheReadTokens).toBe(100);
  });

  test("sessions with zero requests cost zero; unpriced requests poison", () => {
    const rows = aggregateLeaderboard(
      [
        session("s1", "alice", "zcode", "2026-09-09T10:00:00Z"),
        session("s2", "bob", "zcode", "2026-09-09T10:00:00Z"),
      ],
      new Map([
        ["s1", stats(null, 1, 0)],
        ["s2", stats(null, 1, 3)],
      ]),
    );
    expect(rows[0]!.costUsd).toBe(0);
    expect(rows[1]!.costUsd).toBeNull();
  });

  test("missing stats (not yet fetched) keep the row unpriced", () => {
    const rows = aggregateLeaderboard(
      [session("s1", "alice", "zcode", "2026-09-09T10:00:00Z")],
      new Map(),
    );
    expect(rows[0]!.costUsd).toBeNull();
  });

  test("top agent breaks ties alphabetically; null user becomes (unknown)", () => {
    const rows = aggregateLeaderboard(
      [
        session("s1", null, "pi", "2026-09-09T10:00:00Z"),
        session("s2", null, "zcode", "2026-09-09T11:00:00Z"),
        session("s3", null, "pi", "2026-09-09T12:00:00Z"),
      ],
      new Map(),
    );
    const row = rows[0]!;
    expect(row.userId).toBe("(unknown)");
    expect(row.topAgent).toBe("pi");
    expect(row.lastActiveAt).toBe("2026-09-09T12:00:00Z");
  });

  test("sorts by cost desc, nulls last, then output tokens desc", () => {
    const rows = aggregateLeaderboard(
      [
        session("s-free", "free", "zcode", "2026-09-09T10:00:00Z", 100),
        session("s-big", "big", "zcode", "2026-09-09T10:00:00Z", 50),
        session("s-mid", "mid", "zcode", "2026-09-09T10:00:00Z", 90),
      ],
      new Map([
        ["s-free", stats(null, 1, 2)],
        ["s-big", stats(5, 1, 2)],
        ["s-mid", stats(2, 1, 2)],
      ]),
    );
    expect(rows.map((r) => r.userId)).toEqual(["big", "mid", "free"]);
  });
});
