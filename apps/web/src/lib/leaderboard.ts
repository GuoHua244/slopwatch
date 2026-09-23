import type { TokenUsage } from "@slopwatch/events";
import type { ModelRollupRow, RollupsSnapshot, SessionSummary } from "../api";
import { estimateCost, priceFor } from "./pricing";

export type LeaderboardRow = {
  userId: string;
  sessions: number;
  turns: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** All-time list-price estimate; null while any contributing model is unpriced. */
  costUsd: number | null;
  topAgent: string;
  lastActiveAt: string;
  /** UTC-today spend; null while a contributing model is unpriced. */
  todayCostUsd: number | null;
  /** Model requests in the local today — activity regardless of pricing. */
  todayRequests: number;
  /** (today − trailing 7-day mean) / mean; null with no baseline or unpriced. */
  deltaVsWeek: number | null;
  /** Hourly spend over the last 24 UTC hours, oldest → newest. */
  trend: number[];
};

/** UTC day key of a date: "2026-09-12". */
export const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

/** UTC hour key of a date: "2026-09-12T09". */
export const hourKey = (d: Date): string => d.toISOString().slice(0, 13);

/**
 * The viewer's local day key (v2 decision 27): daily display re-buckets the
 * UTC-hour rollups into the browser's calendar days, so for a UTC+8 team
 * "today" ends at local midnight — storage stays UTC (decision 18).
 */
export const localDayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;

/** UTC hour bucket → local day key. */
export const localDayOfHourBucket = (bucket: string): string =>
  localDayKey(new Date(`${bucket}:00Z`));

const rowUsage = (row: ModelRollupRow): TokenUsage => ({
  input_tokens: row.input_tokens,
  output_tokens: row.output_tokens,
  cache_read_tokens: row.cache_read_tokens,
  cache_write_tokens: row.cache_write_tokens,
});

/**
 * List-price estimate over model-grain rollup rows. Zero-request rows cost
 * nothing; an unpriced model with requests poisons the whole sum (same rule
 * the per-event estimator applies).
 */
export const pricedCost = (rows: ModelRollupRow[]): number | null => {
  let cost = 0;
  for (const row of rows) {
    if (row.model_requests === 0) continue;
    const price = priceFor(row.model);
    if (price === null) return null;
    cost += estimateCost(rowUsage(row), price);
  }
  return cost;
};

const groupByUser = (rows: ModelRollupRow[]): Map<string, ModelRollupRow[]> => {
  const byUser = new Map<string, ModelRollupRow[]>();
  for (const row of rows) {
    const list = byUser.get(row.user_id) ?? [];
    list.push(row);
    byUser.set(row.user_id, list);
  }
  return byUser;
};

/** Hourly spend buckets for the last 24 UTC hours; unpriced models draw as 0. */
const hourlyTrend = (rows: ModelRollupRow[], now: Date): number[] => {
  const byHour = new Map<string, number>();
  for (const row of rows) {
    const price = priceFor(row.model);
    if (price === null) continue;
    byHour.set(
      row.bucket,
      (byHour.get(row.bucket) ?? 0) + estimateCost(rowUsage(row), price),
    );
  }
  return Array.from({ length: 24 }, (_, i) => {
    const hour = hourKey(new Date(now.getTime() - (23 - i) * 3_600_000));
    return byHour.get(hour) ?? 0;
  });
};

/** Priced spend + request/token counts + unpriced flag per LOCAL day, from UTC-hour rollup rows. */
const localDaySpend = (
  rows: ModelRollupRow[],
): Map<
  string,
  {
    cost: number;
    unpriced: boolean;
    requests: number;
    inputTokens: number;
    outputTokens: number;
  }
> => {
  const byDay = new Map<
    string,
    {
      cost: number;
      unpriced: boolean;
      requests: number;
      inputTokens: number;
      outputTokens: number;
    }
  >();
  for (const row of rows) {
    const price = priceFor(row.model);
    const day = localDayOfHourBucket(row.bucket);
    const entry = byDay.get(day) ?? {
      cost: 0,
      unpriced: false,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    entry.requests += row.model_requests;
    entry.inputTokens += row.input_tokens;
    entry.outputTokens += row.output_tokens;
    if (price === null) entry.unpriced = true;
    else entry.cost += estimateCost(rowUsage(row), price);
    byDay.set(day, entry);
  }
  return byDay;
};

/**
 * One developer's per-day spend over the last `days` LOCAL days (oldest →
 * newest) — the drill-down chart's data, re-bucketed from UTC-hour rollups
 * into the viewer's calendar days (v2 decision 27). Absent days are zero;
 * unpriced contributions are flagged so the view can annotate rather than
 * misprice.
 */
export const dailyCostSeries = (
  rows: ModelRollupRow[],
  days: number,
  now = new Date(),
): {
  day: string;
  cost: number;
  unpriced: boolean;
  inputTokens: number;
  outputTokens: number;
}[] => {
  const byDay = localDaySpend(rows);
  return Array.from({ length: days }, (_, i) => {
    const day = localDayKey(
      new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - (days - 1 - i),
      ),
    );
    const entry = byDay.get(day);
    return {
      day,
      cost: entry?.cost ?? 0,
      unpriced: entry?.unpriced ?? false,
      inputTokens: entry?.inputTokens ?? 0,
      outputTokens: entry?.outputTokens ?? 0,
    };
  });
};

type SessionFacts = {
  sessions: number;
  lastActiveAt: string;
  agents: Map<string, number>;
};

/**
 * Build the leaderboard from the decision-18 rollups: all-time columns come
 * from the snapshot's totals, today/delta/trend from its hourly windows.
 * Today and the trailing week are LOCAL calendar days re-bucketed from the
 * UTC-hour rows (v2 decision 27) — storage stays UTC. The sessions list
 * keeps supplying session counts, top agent, and last-seen.
 */
export const aggregateLeaderboard = (
  sessions: SessionSummary[],
  rollups: RollupsSnapshot,
  now = new Date(),
): LeaderboardRow[] => {
  const today = localDayKey(now);
  const trailingDays = Array.from({ length: 7 }, (_, i) =>
    localDayKey(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - (i + 1)),
    ),
  );

  const facts = new Map<string, SessionFacts>();
  for (const s of sessions) {
    const key = s.user_id ?? "(unknown)";
    let row = facts.get(key);
    if (!row) {
      row = {
        sessions: 0,
        lastActiveAt: s.last_event_at ?? s.first_seen_at,
        agents: new Map(),
      };
      facts.set(key, row);
    }
    row.sessions += 1;
    // last_event_at is the real "still working" signal; first_seen_at is the
    // fallback for sessions that have not ingested anything yet.
    const seen = s.last_event_at ?? s.first_seen_at;
    if (seen > row.lastActiveAt) row.lastActiveAt = seen;
    row.agents.set(s.agent, (row.agents.get(s.agent) ?? 0) + 1);
  }

  const totalsByUser = new Map(rollups.totals.map((r) => [r.user_id, r]));
  const modelTotalsByUser = groupByUser(rollups.model_totals);
  const hourlyByUser = groupByUser(rollups.model_hourly);

  const userIds = new Set<string>([
    ...facts.keys(),
    ...totalsByUser.keys(),
    ...modelTotalsByUser.keys(),
    ...hourlyByUser.keys(),
  ]);
  return [...userIds]
    .map((userId): LeaderboardRow => {
      const modelTotals = modelTotalsByUser.get(userId) ?? [];
      const localDays = localDaySpend(hourlyByUser.get(userId) ?? []);
      const todayEntry = localDays.get(today);
      const todayCost = todayEntry
        ? todayEntry.unpriced
          ? null
          : todayEntry.cost
        : 0;
      let trailingSum = 0;
      let trailingPriced = true;
      for (const day of trailingDays) {
        const dayEntry = localDays.get(day);
        if (dayEntry === undefined) continue; // zero day
        if (dayEntry.unpriced) trailingPriced = false;
        else trailingSum += dayEntry.cost;
      }
      const trailingMean = trailingSum / 7;
      return {
        userId,
        sessions: facts.get(userId)?.sessions ?? 0,
        turns: totalsByUser.get(userId)?.turns ?? 0,
        requests: modelTotals.reduce((sum, r) => sum + r.model_requests, 0),
        inputTokens: modelTotals.reduce((sum, r) => sum + r.input_tokens, 0),
        outputTokens: modelTotals.reduce((sum, r) => sum + r.output_tokens, 0),
        cacheReadTokens: modelTotals.reduce(
          (sum, r) => sum + r.cache_read_tokens,
          0,
        ),
        costUsd: pricedCost(modelTotals),
        topAgent: topAgent(facts.get(userId)?.agents ?? new Map()),
        lastActiveAt: facts.get(userId)?.lastActiveAt ?? "",
        todayCostUsd: todayCost,
        todayRequests: todayEntry?.requests ?? 0,
        deltaVsWeek:
          todayCost !== null && trailingPriced && trailingMean > 0
            ? (todayCost - trailingMean) / trailingMean
            : null,
        trend: hourlyTrend(hourlyByUser.get(userId) ?? [], now),
      };
    })
    .sort((a, b) => {
      if (a.costUsd === null && b.costUsd !== null) return 1;
      if (b.costUsd === null && a.costUsd !== null) return -1;
      const costDelta = (b.costUsd ?? 0) - (a.costUsd ?? 0);
      if (costDelta !== 0) return costDelta;
      if (b.outputTokens !== a.outputTokens)
        return b.outputTokens - a.outputTokens;
      return a.userId.localeCompare(b.userId);
    });
};

/** Most-used agent; alphabetical tiebreak keeps the pick deterministic. */
const topAgent = (agents: Map<string, number>): string =>
  [...agents.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0]?.[0] ?? "";
