import type { SessionSummary } from "../api";

export type SessionStats = {
  costUsd: number | null;
  turns: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
};

export type LeaderboardRow = {
  userId: string;
  sessions: number;
  turns: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** null while any contributing session's cost is unknown. */
  costUsd: number | null;
  topAgent: string;
  lastActiveAt: string;
};

type Draft = {
  userId: string;
  sessions: number;
  turns: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cost: number;
  /** False once a session with unpriced requests contributes. */
  priced: boolean;
  topAgent: string;
  lastActiveAt: string;
  agents: Map<string, number>;
};

/**
 * Roll the session list up into per-developer leaderboard rows (the "who is
 * spending / working the most" surface from the leaderboard design). Turns,
 * requests, cost, and tokens come from the event-backed stats map — the
 * Server's sessions token columns undercount sessions that predate that
 * migration — falling back to them only while events are still loading.
 */
export const aggregateLeaderboard = (
  sessions: SessionSummary[],
  statsBySession: Map<string, SessionStats>,
): LeaderboardRow[] => {
  const byUser = new Map<string, Draft>();
  for (const s of sessions) {
    const key = s.user_id ?? "(unknown)";
    let row = byUser.get(key);
    if (!row) {
      row = {
        userId: key,
        sessions: 0,
        turns: 0,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cost: 0,
        priced: true,
        topAgent: "",
        lastActiveAt: s.first_seen_at,
        agents: new Map(),
      };
      byUser.set(key, row);
    }
    row.sessions += 1;
    if (s.first_seen_at > row.lastActiveAt) row.lastActiveAt = s.first_seen_at;
    row.agents.set(s.agent, (row.agents.get(s.agent) ?? 0) + 1);

    const stats = statsBySession.get(s.session_id);
    if (!stats) {
      // Event stats not fetched yet — fall back to the Server's token
      // columns and keep the row unpriced until known.
      row.inputTokens += s.total_input_tokens;
      row.outputTokens += s.total_output_tokens;
      row.cacheReadTokens += s.total_cache_read_tokens;
      row.priced = false;
    } else {
      row.inputTokens += stats.inputTokens;
      row.outputTokens += stats.outputTokens;
      row.cacheReadTokens += stats.cacheReadTokens;
      row.turns += stats.turns;
      row.requests += stats.requests;
      if (stats.requests > 0) {
        if (stats.costUsd === null) row.priced = false;
        else row.cost += stats.costUsd;
      }
    }
  }

  return [...byUser.values()]
    .map((row) => ({
      userId: row.userId,
      sessions: row.sessions,
      turns: row.turns,
      requests: row.requests,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      costUsd: row.priced ? row.cost : null,
      topAgent: topAgent(row.agents),
      lastActiveAt: row.lastActiveAt,
    }))
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
