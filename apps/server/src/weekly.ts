/**
 * The team weekly report runner (v3 decision 36): assembles the week's facts
 * from the aggregates the server already keeps — rollup windows, the week's
 * biggest sessions, the commits its tool calls made — and critiques them with
 * the requesting admin's own LLM credentials (ADR 0010's caller-pays rule
 * carries). One synchronous call per generation; the assembled data and the
 * resolved prompt ride in the stored row, so any report stays reproducible.
 */
import { chatCompletionDetailed, type FetchLike } from "@slopwatch/summary";
import type { DailyRollupRow, Store, WeeklyReportRow } from "./store";

/** Days in one report window: the trailing seven UTC days. */
export const WEEK_DAYS = 7;

export type WeekWindow = {
  /** Inclusive first UTC day of the report window, "YYYY-MM-DD". */
  sinceDay: string;
  /** Exclusive day after the window's last — the half-open [since, until). */
  untilDay: string;
  prevSinceDay: string;
  prevUntilDay: string;
};

/**
 * Trailing-seven-UTC-days ending yesterday, and the seven before it for the
 * week-over-week delta. Yesterday-ending keeps "the week's report" stable
 * all day: today's partial numbers never leak into a run.
 */
export const weekWindow = (now: Date, weekDays = WEEK_DAYS): WeekWindow => {
  const day = (d: Date): string => d.toISOString().slice(0, 10);
  // yesterday 00:00 UTC — the first day outside the window
  const until = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const since = new Date(until.getTime() - weekDays * 86_400_000);
  const prevUntil = new Date(since.getTime());
  const prevSince = new Date(prevUntil.getTime() - weekDays * 86_400_000);
  return {
    sinceDay: day(since),
    untilDay: day(until),
    prevSinceDay: day(prevSince),
    prevUntilDay: day(prevUntil),
  };
};

/**
 * The per-developer table: activity and waste, this week vs last. A user
 * appears when either week saw any activity — the delta against zero is the
 * story. A week's row sums the user's daily rows; waste rate = (failed +
 * repeated) / tool calls, the same definition the leaderboard renders.
 */
export const weeklyUserTable = (data: {
  daily: DailyRollupRow[];
  sinceDay: string;
  untilDay: string;
  prevSinceDay: string;
  prevUntilDay: string;
}): string => {
  const zero = {
    turns: 0,
    tool_calls: 0,
    failed_tool_calls: 0,
    repeated_calls: 0,
  };
  const users = new Map<string, { cur: typeof zero; prev: typeof zero }>();
  const bump = (
    userId: string,
    slot: "cur" | "prev",
    row: DailyRollupRow,
  ): void => {
    const entry = users.get(userId) ?? { cur: { ...zero }, prev: { ...zero } };
    const target = entry[slot];
    target.turns += row.turns;
    target.tool_calls += row.tool_calls;
    target.failed_tool_calls += row.failed_tool_calls;
    target.repeated_calls += row.repeated_calls;
    users.set(userId, entry);
  };
  for (const row of data.daily) {
    if (row.day >= data.sinceDay && row.day < data.untilDay)
      bump(row.user_id, "cur", row);
    else if (row.day >= data.prevSinceDay && row.day < data.prevUntilDay)
      bump(row.user_id, "prev", row);
  }
  const rate = (week: typeof zero): string => {
    if (week.tool_calls === 0)
      return week.failed_tool_calls + week.repeated_calls > 0 ? "n/a" : "—";
    return `${(((week.failed_tool_calls + week.repeated_calls) / week.tool_calls) * 100).toFixed(1)}%`;
  };
  const lines = [
    "| developer | turns (cur/prev) | tool calls (cur/prev) | waste rate cur | waste rate prev |",
    "|---|---|---|---|---|",
  ];
  for (const [userId, week] of [...users.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    lines.push(
      `| ${userId} | ${week.cur.turns}/${week.prev.turns} | ${week.cur.tool_calls}/${week.prev.tool_calls} | ${rate(week.cur)} | ${rate(week.prev)} |`,
    );
  }
  return lines.join("\n");
};

/**
 * The full data document the prompt receives — every number it may cite,
 * with the window stated so the report can't invent one.
 */
export const assembleWeeklyData = async (
  store: Store,
  window: WeekWindow,
  teamId?: string,
): Promise<string> => {
  // One rollups call lower-bounded at the previous week's start covers both
  // weeks; the tables split the buckets themselves.
  const snap = await store.listRollups(
    window.prevSinceDay,
    `${window.prevSinceDay}T00`,
    teamId,
    undefined,
  );
  const topSessions = await store.topSessionsByTokens({
    sinceDay: window.sinceDay,
    untilDay: window.untilDay,
    teamId,
    limit: 10,
  });
  const commits = await store.commitsSince({
    sinceDay: window.sinceDay,
    untilDay: window.untilDay,
    teamId,
    limit: 50,
  });
  const modelTotals = new Map<string, { requests: number; tokens: number }>();
  for (const row of snap.model_daily) {
    if (row.bucket < window.sinceDay || row.bucket >= window.untilDay) continue;
    const entry = modelTotals.get(row.model) ?? { requests: 0, tokens: 0 };
    entry.requests += row.model_requests;
    entry.tokens +=
      row.input_tokens +
      row.output_tokens +
      row.cache_read_tokens +
      row.cache_write_tokens;
    modelTotals.set(row.model, entry);
  }
  const sections = [
    `Report window: ${window.sinceDay} .. ${window.untilDay} (UTC days; the until day is exclusive)`,
    `Previous week: ${window.prevSinceDay} .. ${window.prevUntilDay}`,
    "",
    "## Per-developer activity and waste",
    weeklyUserTable({ ...window, daily: snap.daily }),
    "",
    "## Model mix (this week)",
    ...(modelTotals.size === 0
      ? ["(no model requests in the window)"]
      : [
          "| model | requests | tokens |",
          "|---|---|---|",
          ...[...modelTotals.entries()]
            .sort((a, b) => b[1].tokens - a[1].tokens)
            .map(([model, v]) => `| ${model} | ${v.requests} | ${v.tokens} |`),
        ]),
    "",
    "## Biggest sessions this week (by tokens)",
    ...(topSessions.length === 0
      ? ["(none)"]
      : [
          "| session | developer | agent | tokens | title |",
          "|---|---|---|---|---|",
          ...topSessions.map(
            (s) =>
              `| ${s.session_id.slice(0, 12)}… | ${s.user_id ?? "?"} | ${s.agent} | ${s.tokens} | ${(s.title ?? "(untitled)").replace(/\|/g, "/")} |`,
          ),
        ]),
    "",
    "## Shipped commits this week",
    ...(commits.length === 0
      ? ["(none captured)"]
      : [
          "| sha | subject | developer | day |",
          "|---|---|---|---|",
          ...commits.map(
            (c) =>
              `| ${c.sha ?? "—"} | ${(c.subject ?? "(no subject)").replace(/\|/g, "/")} | ${c.user_id ?? "?"} | ${c.occurred_at.slice(0, 10)} |`,
          ),
        ]),
  ];
  return sections.join("\n");
};

export const WEEKLY_SYSTEM = `You are a team-lead's weekly analyst for slopwatch, a coding-agent observability platform. You receive the week's measured facts as tables and write a short, concrete weekly report in Markdown. Structure: a two-sentence overview; "Where the tokens went" citing the biggest movers and sessions by name; "Waste" calling out failed or repeated-call patterns with numbers; "Shipped" summarizing the commits; "Next week" with at most three specific, actionable suggestions. Cite only numbers the tables carry — never invent a metric, a session, or a sha. Keep it under 600 words.`;

export type WeeklyRunner = {
  generate(requestedBy: string, teamId?: string): Promise<WeeklyReportRow>;
};

export const createWeeklyRunner = (
  store: Store,
  {
    fetchImpl,
    now = () => new Date(),
  }: { fetchImpl?: FetchLike; now?: () => Date } = {},
): WeeklyRunner => ({
  async generate(requestedBy, teamId) {
    const window = weekWindow(now());
    const dataSnapshot = await assembleWeeklyData(store, window, teamId);
    const config = await store.getLlmConfig(requestedBy);
    if (config === null) {
      return store.addWeeklyReport({
        requested_by: requestedBy,
        team_id: teamId ?? null,
        since_day: window.sinceDay,
        until_day: window.untilDay,
        data_snapshot: dataSnapshot,
        prompt_snapshot: WEEKLY_SYSTEM,
        status: "failed",
        result: null,
        model: null,
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        reasoning_tokens: null,
        error:
          "the requester has no LLM credentials configured — set them on the profile page and rerun",
      });
    }
    try {
      const result = await chatCompletionDetailed({
        endpoint: config.endpoint,
        model: config.model,
        apiKey: config.apiKey,
        system: WEEKLY_SYSTEM,
        user: dataSnapshot,
        maxTokens: 8_192,
        firstByteTimeoutMs: 300_000,
        timeoutMs: 600_000,
        fetchImpl,
      });
      const u = result.usage ?? {};
      return store.addWeeklyReport({
        requested_by: requestedBy,
        team_id: teamId ?? null,
        since_day: window.sinceDay,
        until_day: window.untilDay,
        data_snapshot: dataSnapshot,
        prompt_snapshot: WEEKLY_SYSTEM,
        status: result.text !== null ? "completed" : "failed",
        result: result.text,
        model: config.model,
        input_tokens: u.input_tokens ?? null,
        output_tokens: u.output_tokens ?? null,
        cache_read_tokens: u.cache_read_tokens ?? null,
        reasoning_tokens: u.reasoning_tokens ?? null,
        error: result.text === null ? (result.error ?? "no content") : null,
      });
    } catch (e) {
      return store.addWeeklyReport({
        requested_by: requestedBy,
        team_id: teamId ?? null,
        since_day: window.sinceDay,
        until_day: window.untilDay,
        data_snapshot: dataSnapshot,
        prompt_snapshot: WEEKLY_SYSTEM,
        status: "failed",
        result: null,
        model: config.model,
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        reasoning_tokens: null,
        error: `the runner crashed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  },
});
