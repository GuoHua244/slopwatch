import { describe, expect, test } from "bun:test";
import type { ModelRollupRow, RollupsSnapshot, SessionSummary } from "../api";
import {
  aggregateLeaderboard,
  dailyCostSeries,
  localDayKey,
  type LeaderboardRow,
} from "./leaderboard";

const NOW = new Date("2026-09-12T10:00:00Z"); // UTC: today 09-12, trailing 09-05..09-11
const PRICED = "GLM-5.3-Flash"; // $0.15/M in, $0.50/M out
const UNPRICED = "some-unknown-model";

/** UTC hour bucket for `hour` o'clock, `dayOffset` local days from NOW. */
const localHourBucket = (dayOffset: number, hour: number): string =>
  new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + dayOffset, hour)
    .toISOString()
    .slice(0, 13);

const localDay = (dayOffset: number): string =>
  localDayKey(
    new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + dayOffset),
  );

const session = (
  sessionId: string,
  userId: string | null,
  agent: string,
  firstSeenAt: string,
  outputTokens = 0,
  lastEventAt: string | null = null,
): SessionSummary => ({
  session_id: sessionId,
  agent,
  user_id: userId,
  first_seen_at: firstSeenAt,
  last_event_at: lastEventAt,
  last_seq: 1,
  title: null,
  task_preview: null,
  total_input_tokens: 10,
  total_output_tokens: outputTokens,
  total_cache_read_tokens: 0,
  total_cache_write_tokens: 0,
});

const modelRow = (
  user_id: string,
  bucket: string,
  model: string,
  modelRequests: number,
  inputTokens = 0,
  outputTokens = 0,
): ModelRollupRow => ({
  user_id,
  bucket,
  model,
  model_requests: modelRequests,
  input_tokens: inputTokens,
  output_tokens: outputTokens,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
});

// 1M in + 1M out on the Flash price line costs exactly $0.65.
const MEGA = 1_000_000;

const snapshot = (partial: Partial<RollupsSnapshot> = {}): RollupsSnapshot => ({
  totals: [],
  daily: [],
  user_hourly: [],
  model_daily: [],
  model_totals: [],
  model_hourly: [],
  ...partial,
});

const byUser = (rows: LeaderboardRow[], userId: string): LeaderboardRow =>
  rows.find((r) => r.userId === userId)!;

describe("aggregateLeaderboard", () => {
  test("all-time columns come from rollup totals, sessions facts from the list", () => {
    const rows = aggregateLeaderboard(
      [
        session("s1", "alice", "zcode", "2026-09-09T10:00:00Z"),
        session("s2", "alice", "pi", "2026-09-09T11:00:00Z"),
        session("s3", "bob", "zcode", "2026-09-09T09:00:00Z"),
      ],
      snapshot({
        totals: [{ user_id: "alice", turns: 4, tool_calls: 7 }],
        model_totals: [
          modelRow("alice", "", PRICED, 6, 300, 110),
          modelRow("bob", "", PRICED, 1, 5, 1),
        ],
      }),
      NOW,
    );
    expect(rows.map((r) => r.userId)).toEqual(["alice", "bob"]);
    const alice = rows[0]!;
    expect(alice.sessions).toBe(2);
    expect(alice.turns).toBe(4);
    expect(alice.requests).toBe(6);
    expect(alice.inputTokens).toBe(300);
    expect(alice.outputTokens).toBe(110);
    expect(alice.topAgent).toBe("pi");
    expect(alice.lastActiveAt).toBe("2026-09-09T11:00:00Z");
    expect(alice.trend).toHaveLength(24);
  });

  test("last seen follows the session's last event, not its creation", () => {
    const rows = aggregateLeaderboard(
      [
        session(
          "s1",
          "alice",
          "zcode",
          "2026-09-09T10:00:00Z",
          0,
          "2026-09-11T23:00:00Z",
        ),
        session("s2", "alice", "pi", "2026-09-09T11:00:00Z"),
      ],
      snapshot(),
      NOW,
    );
    // A long-running session's last_event_at beats a newer session's start.
    expect(byUser(rows, "alice").lastActiveAt).toBe("2026-09-11T23:00:00Z");
  });

  test("todayRequests counts local-today activity regardless of pricing", () => {
    const rows = aggregateLeaderboard(
      [],
      snapshot({
        model_hourly: [
          // yesterday local: ignored
          modelRow("alice", localHourBucket(-1, 9), UNPRICED, 5),
          // today local: counted even though the model is unpriced
          modelRow("alice", localHourBucket(0, 9), UNPRICED, 2),
          modelRow("bob", localHourBucket(0, 9), PRICED, 7),
        ],
      }),
      NOW,
    );
    expect(byUser(rows, "alice").todayRequests).toBe(2);
    expect(byUser(rows, "bob").todayRequests).toBe(7);
    // unpriced models still hide spend while counting as activity
    expect(byUser(rows, "alice").todayCostUsd).toBeNull();
  });

  test("cost is priced per model row; an unpriced model poisons the sum", () => {
    const rows = aggregateLeaderboard(
      [],
      snapshot({
        model_totals: [
          modelRow("alice", "", PRICED, 2, MEGA, MEGA),
          modelRow("alice", "", PRICED, 1, MEGA, MEGA),
          modelRow("bob", "", UNPRICED, 3, MEGA, MEGA),
        ],
      }),
      NOW,
    );
    expect(byUser(rows, "alice").costUsd).toBeCloseTo(1.3, 6);
    expect(byUser(rows, "bob").costUsd).toBeNull();
    // Unpriced rows sort last.
    expect(rows.map((r) => r.userId)).toEqual(["alice", "bob"]);
  });

  test("delta compares the LOCAL day against the trailing 7-day mean", () => {
    // hourly rows, re-bucketed into the viewer's calendar days (decision 27)
    const rows = aggregateLeaderboard(
      [],
      snapshot({
        model_hourly: [
          modelRow(
            "alice",
            localHourBucket(0, NOW.getHours()),
            PRICED,
            1,
            MEGA,
            MEGA,
          ),
          modelRow(
            "alice",
            localHourBucket(-1, NOW.getHours()),
            PRICED,
            1,
            MEGA,
            MEGA,
          ),
          // The other six trailing days are absent → they count as zero,
          // so the mean is 0.65/7 and today is exactly 7× it.
          modelRow(
            "bob",
            localHourBucket(0, NOW.getHours()),
            PRICED,
            1,
            MEGA,
            MEGA,
          ),
        ],
      }),
      NOW,
    );
    const alice = byUser(rows, "alice");
    expect(alice.todayCostUsd).toBeCloseTo(0.65, 6);
    expect(alice.deltaVsWeek).toBeCloseTo(6, 6);
    // Bob has no baseline (all seven trailing days are zero).
    expect(byUser(rows, "bob").deltaVsWeek).toBeNull();
  });

  test("today's unpriced spend hides the delta instead of mispricing it", () => {
    const rows = aggregateLeaderboard(
      [],
      snapshot({
        model_hourly: [
          modelRow(
            "alice",
            localHourBucket(0, NOW.getHours()),
            UNPRICED,
            1,
            MEGA,
            MEGA,
          ),
          modelRow(
            "alice",
            localHourBucket(-1, NOW.getHours()),
            PRICED,
            1,
            MEGA,
            MEGA,
          ),
        ],
      }),
      NOW,
    );
    expect(byUser(rows, "alice").todayCostUsd).toBeNull();
    expect(byUser(rows, "alice").deltaVsWeek).toBeNull();
  });

  test("the trend is the last 24 UTC hours of priced spend", () => {
    const rows = aggregateLeaderboard(
      [],
      snapshot({
        model_hourly: [
          modelRow("alice", "2026-09-12T08", PRICED, 1, MEGA, MEGA),
          modelRow("alice", "2026-09-11T11", PRICED, 1, MEGA, MEGA),
        ],
      }),
      NOW,
    );
    const trend = byUser(rows, "alice").trend;
    expect(trend).toHaveLength(24);
    // NOW is 10:00Z — bucket 0 is 11:00Z yesterday, so 11:00Z is index 0
    // and 08:00Z today is index 21; both price to $0.65.
    expect(trend[0]).toBeCloseTo(0.65, 6);
    expect(trend[21]).toBeCloseTo(0.65, 6);
    expect(trend[1]).toBe(0);
  });

  test("sessions with no rollups yet (unknown user) still render a row", () => {
    const rows = aggregateLeaderboard(
      [session("s1", null, "pi", "2026-09-09T10:00:00Z")],
      snapshot(),
      NOW,
    );
    const row = rows[0]!;
    expect(row.userId).toBe("(unknown)");
    expect(row.sessions).toBe(1);
    expect(row.turns).toBe(0);
    // Zero requests cost zero — the old estimator's rule, kept.
    expect(row.costUsd).toBe(0);
  });
});

describe("dailyCostSeries", () => {
  test("spans the requested LOCAL days oldest → newest with zeros for gaps", () => {
    const series = dailyCostSeries(
      [
        modelRow("alice", localHourBucket(-1, 12), PRICED, 1, MEGA, MEGA),
        modelRow("alice", localHourBucket(0, 9), UNPRICED, 1, MEGA, MEGA),
      ],
      5,
      NOW,
    );
    expect(series.map((d) => d.day)).toEqual([
      localDay(-4),
      localDay(-3),
      localDay(-2),
      localDay(-1),
      localDay(0),
    ]);
    expect(series[3]).toEqual({
      day: localDay(-1),
      cost: 0.65,
      unpriced: false,
      inputTokens: MEGA,
      outputTokens: MEGA,
    });
    expect(series[4]).toEqual({
      day: localDay(0),
      cost: 0,
      unpriced: true,
      inputTokens: MEGA,
      outputTokens: MEGA,
    });
  });

  test("token counts accumulate per day even when the model is unpriced", () => {
    const series = dailyCostSeries(
      [
        modelRow("alice", localHourBucket(-2, 8), PRICED, 2, 300, 120),
        modelRow("alice", localHourBucket(-2, 20), UNPRICED, 1, 50, 30),
      ],
      4,
      NOW,
    );
    const day = series[1]!; // days=4 spans offsets -3..0; the rows sit on offset -2
    expect(day.inputTokens).toBe(350);
    expect(day.outputTokens).toBe(150);
    expect(day.unpriced).toBe(true);
  });
});
