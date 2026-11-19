import { storedToken } from "../auth";
import { bearerAuth, defaultFetch, getJson, type FetchLike } from "./http";
import type {
  RollupsSnapshot,
  SessionCommitRow,
  SessionSummary,
  StoredEvent,
  TeamInfo,
} from "./types";

export type Api = {
  /**
   * The session list. `teamId` scopes to one team (or the "unassigned"
   * bucket); `userId` scopes to one developer's own sessions
   * (server-side — the drill-down never pulls the whole org).
   */
  listSessions(teamId?: string, userId?: string): Promise<SessionSummary[]>;
  /** Decision 8: incremental page of a session's events after sinceSeq. */
  eventsSince(sessionId: string, sinceSeq: number): Promise<StoredEvent[]>;
  /**
   * v3 decision 34: the git commits one session's tool calls made.
   */
  listCommits(sessionId: string): Promise<SessionCommitRow[]>;
  /**
   * Decision 18: per-developer usage rollups. `days` lower-bounds the daily
   * windows (absent = all history); `hours` the hourly window (server
   * default 24). Totals always cover all history. `teamId` scopes every
   * window server-side to one team's members ("unassigned" bucket included).
   */
  rollups(params?: {
    days?: number;
    hours?: number;
    teamId?: string;
  }): Promise<RollupsSnapshot>;
  /** Decision 23: the roster, for the leaderboard's team grouping. */
  teams(): Promise<TeamInfo[]>;
};

/**
 * Dashboard client over the Server's read endpoints (same-origin). Every
 * call carries the browser's user token (v2 decision 22 / ADR 0003) — the
 * token is read per request, so a sign-in anywhere applies everywhere.
 */
export const createApi = (
  doFetch: FetchLike = defaultFetch,
  getToken: () => string | null = storedToken,
): Api => {
  const auth = bearerAuth(getToken);
  return {
    listSessions: async (teamId, userId) => {
      const parts: string[] = [];
      if (teamId !== undefined)
        parts.push(`team_id=${encodeURIComponent(teamId)}`);
      if (userId !== undefined)
        parts.push(`user_id=${encodeURIComponent(userId)}`);
      const query = parts.length > 0 ? `?${parts.join("&")}` : "";
      return (
        await getJson<{ sessions: SessionSummary[] }>(
          doFetch,
          `/sessions${query}`,
          auth(),
        )
      ).sessions;
    },
    eventsSince: async (sessionId, sinceSeq) =>
      (
        await getJson<{ events: StoredEvent[] }>(
          doFetch,
          `/sessions/${encodeURIComponent(sessionId)}/events?since_seq=${sinceSeq}`,
          auth(),
        )
      ).events,
    listCommits: async (sessionId) =>
      (
        await getJson<{ commits: SessionCommitRow[] }>(
          doFetch,
          `/sessions/${encodeURIComponent(sessionId)}/commits`,
          auth(),
        )
      ).commits,
    rollups: async (params = {}) => {
      const search = new URLSearchParams();
      if (params.days !== undefined) search.set("days", String(params.days));
      if (params.hours !== undefined) search.set("hours", String(params.hours));
      if (params.teamId !== undefined) search.set("team_id", params.teamId);
      const query = search.toString();
      return getJson<RollupsSnapshot>(
        doFetch,
        `/rollups${query ? `?${query}` : ""}`,
        auth(),
      );
    },
    teams: async () =>
      (await getJson<{ teams: TeamInfo[] }>(doFetch, "/teams", auth())).teams,
  };
};
