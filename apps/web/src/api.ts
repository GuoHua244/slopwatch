import type { NormalEvent } from "@slopwatch/events";
import { storedToken } from "./auth";

/** One row of GET /sessions — mirrors the Server's SessionRow. */
export type SessionSummary = {
  session_id: string;
  agent: string;
  user_id: string | null;
  first_seen_at: string;
  last_seq: number;
  title: string | null;
  task_preview: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
};

/** One entry of GET /sessions/:id/events — a NormalEvent plus its seq. */
export type StoredEvent = { event_seq: number; event: NormalEvent };

/** The accountability marker (decision 10): one review per session. */
export type ReviewRow = {
  session_id: string;
  reviewer_id: string;
  reviewed_at: string;
};

/** A review note, session-level (turn_id null) or pinned to one turn. */
export type CommentRow = {
  comment_id: number;
  session_id: string;
  turn_id: string | null;
  author_id: string;
  body: string;
  created_at: string;
};

/** GET /me — the identity behind the reader's bearer token. */
export type MeInfo = { user: string; is_dri: boolean };

/** Row of GET /rollups — per-day turn/tool counts for one user. */
export type DailyRollupRow = {
  user_id: string;
  /** UTC day, "YYYY-MM-DD". */
  day: string;
  turns: number;
  tool_calls: number;
};

/** Row of GET /rollups — per-hour turn/tool counts for one user. */
export type UserHourlyRollupRow = {
  user_id: string;
  /** UTC hour, "YYYY-MM-DDTHH". */
  hour: string;
  turns: number;
  tool_calls: number;
};

/**
 * Row of GET /rollups — per-model request/token counts over a UTC day or
 * hour bucket. Model grain comes back verbatim so the client keeps pricing.
 */
export type ModelRollupRow = {
  user_id: string;
  /** "YYYY-MM-DD" (daily) or "YYYY-MM-DDTHH" (hourly). */
  bucket: string;
  model: string;
  model_requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
};

/** One GET /rollups answer: all-time totals plus the requested windows. */
export type RollupsSnapshot = {
  totals: { user_id: string; turns: number; tool_calls: number }[];
  model_totals: ModelRollupRow[];
  daily: DailyRollupRow[];
  user_hourly: UserHourlyRollupRow[];
  model_daily: ModelRollupRow[];
  model_hourly: ModelRollupRow[];
};

export type ReviewApi = {
  me(): Promise<MeInfo>;
  /** Org-wide read: the session's review marker, or null when unreviewed. */
  review(sessionId: string): Promise<ReviewRow | null>;
  /** DRI-only server-side; 403 surfaces as ApiError for non-DRIs. */
  markReviewed(sessionId: string): Promise<ReviewRow>;
  unmarkReviewed(sessionId: string): Promise<void>;
  comments(sessionId: string): Promise<CommentRow[]>;
  addComment(
    sessionId: string,
    turnId: string | null,
    body: string,
  ): Promise<CommentRow>;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly method = "GET",
  ) {
    super(`${method} ${path} failed with ${status}`);
    this.name = "ApiError";
  }
}

export type Api = {
  listSessions(teamId?: string): Promise<SessionSummary[]>;
  /** Decision 8: incremental page of a session's events after sinceSeq. */
  eventsSince(sessionId: string, sinceSeq: number): Promise<StoredEvent[]>;
  /**
   * Decision 18: per-developer usage rollups. `days` lower-bounds the daily
   * windows (absent = all history); `hours` the hourly window (server
   * default 24). Totals always cover all history.
   */
  rollups(params?: { days?: number; hours?: number }): Promise<RollupsSnapshot>;
  /** Decision 23: the roster, for the leaderboard's team grouping. */
  teams(): Promise<TeamInfo[]>;
};

/** One row of GET /admin/users — mirrors the Server's AdminUserRow. */
export type AdminUserRow = {
  name: string;
  email: string | null;
  disabled: boolean;
  is_dri: boolean;
  created_at: string;
  active_tokens: number;
  team_id: string | null;
  team_name: string | null;
};

/** Row of GET /teams — the roster grouping for the leaderboard (decision 23). */
export type TeamInfo = {
  id: string;
  name: string;
  members: string[];
};

/** Row of GET /admin/teams — mirrors the Server's TeamRow. */
export type AdminTeamRow = {
  id: string;
  name: string;
  raw_retention_days: number | null;
  created_at: string;
  member_count: number;
};

/** Row of GET /admin/users/:name/tokens — plaintext secrets never come back. */
export type AdminTokenRow = {
  token_id: string;
  hint: string;
  created_at: string;
  revoked_at: string | null;
};

/** Payload of POST /admin/users/:name/tokens — the plaintext shows once. */
export type MintedToken = { token_id: string; hint: string; token: string };

/** Row of GET /admin/quarantine — one unparseable listener line, verbatim. */
export type QuarantineRow = {
  seq: number;
  agent: string;
  session_id: string;
  reason: string;
  line: string;
  occurred_at: string;
  created_at: string;
};

export type AdminHealth = {
  ok: boolean;
  sessions: number;
  events: number;
  last_event_at: string | null;
  quarantine_total: number;
  quarantine_24h: number;
  last_quarantine_at: string | null;
};

export type AdminApi = {
  users(): Promise<AdminUserRow[]>;
  createUser(name: string, email: string | null): Promise<AdminUserRow>;
  setUserDisabled(name: string, disabled: boolean): Promise<void>;
  setUserDri(name: string, isDri: boolean): Promise<void>;
  deleteUser(name: string): Promise<void>;
  mintToken(name: string): Promise<MintedToken>;
  tokens(name: string): Promise<AdminTokenRow[]>;
  revokeToken(tokenId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  health(): Promise<AdminHealth>;
  quarantine(limit?: number): Promise<QuarantineRow[]>;
  teams(): Promise<AdminTeamRow[]>;
  settings(): Promise<Record<string, string>>;
  updateSettings(patch: Record<string, string>): Promise<void>;
  testWebhook(): Promise<void>;
  createTeam(
    name: string,
    rawRetentionDays: number | null,
  ): Promise<AdminTeamRow>;
  updateTeam(
    id: string,
    patch: { name?: string; raw_retention_days?: number | null },
  ): Promise<void>;
  deleteTeam(id: string): Promise<void>;
  setUserTeam(name: string, teamId: string | null): Promise<void>;
};

/**
 * Minimal fetch surface the client needs (string URL in, Response out).
 * The global fetch satisfies it; tests inject stubs.
 */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

const getJson = async <T>(
  doFetch: FetchLike,
  path: string,
  init: RequestInit = {},
): Promise<T> => {
  const res = await doFetch(path, init);
  if (!res.ok) throw new ApiError(res.status, path);
  return (await res.json()) as T;
};

const unwrapJson = async <T = void>(
  doFetch: FetchLike,
  path: string,
  init: RequestInit,
  method: string,
): Promise<T> => {
  const res = await doFetch(path, init);
  if (!res.ok) throw new ApiError(res.status, path, method);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
};

/**
 * Dashboard client over the Server's read endpoints (same-origin). Every
 * call carries the browser's user token (v2 decision 22 / ADR 0003) — the
 * token is read per request, so a sign-in anywhere applies everywhere.
 */
export const createApi = (
  doFetch: FetchLike = fetch,
  getToken: () => string | null = storedToken,
): Api => {
  const auth = (init: RequestInit = {}): RequestInit => {
    const token = getToken();
    return {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    };
  };
  return {
    listSessions: async (teamId) =>
      (
        await getJson<{ sessions: SessionSummary[] }>(
          doFetch,
          teamId === undefined
            ? "/sessions"
            : `/sessions?team_id=${encodeURIComponent(teamId)}`,
          auth(),
        )
      ).sessions,
    eventsSince: async (sessionId, sinceSeq) =>
      (
        await getJson<{ events: StoredEvent[] }>(
          doFetch,
          `/sessions/${encodeURIComponent(sessionId)}/events?since_seq=${sinceSeq}`,
          auth(),
        )
      ).events,
    rollups: async (params = {}) => {
      const search = new URLSearchParams();
      if (params.days !== undefined) search.set("days", String(params.days));
      if (params.hours !== undefined) search.set("hours", String(params.hours));
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

/**
 * Review-plane client (decision 10). Reads and writes both carry the
 * reader's user token (v2 decision 22); the review marker additionally
 * requires the DRI role, enforced server-side.
 */
export const createReviewApi = (
  userToken: () => string | null,
  doFetch: FetchLike = fetch,
): ReviewApi => {
  const auth = (init: RequestInit = {}): RequestInit => {
    const token = userToken();
    return {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    };
  };
  const authedJson = (method: string, body: unknown): RequestInit =>
    auth({
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    me: async () =>
      unwrapJson<MeInfo>(doFetch, "/me", auth({ method: "GET" }), "GET"),
    review: async (sessionId) =>
      (
        await getJson<{ review: ReviewRow | null }>(
          doFetch,
          `/sessions/${encodeURIComponent(sessionId)}/review`,
          auth(),
        )
      ).review,
    markReviewed: async (sessionId) =>
      (
        await unwrapJson<{ review: ReviewRow }>(
          doFetch,
          `/sessions/${encodeURIComponent(sessionId)}/review`,
          auth({ method: "POST" }),
          "POST",
        )
      ).review,
    unmarkReviewed: async (sessionId) => {
      await unwrapJson(
        doFetch,
        `/sessions/${encodeURIComponent(sessionId)}/review`,
        auth({ method: "DELETE" }),
        "DELETE",
      );
    },
    comments: async (sessionId) =>
      (
        await getJson<{ comments: CommentRow[] }>(
          doFetch,
          `/sessions/${encodeURIComponent(sessionId)}/comments`,
          auth(),
        )
      ).comments,
    addComment: async (sessionId, turnId, body) =>
      (
        await unwrapJson<{ comment: CommentRow }>(
          doFetch,
          `/sessions/${encodeURIComponent(sessionId)}/comments`,
          authedJson("POST", { turn_id: turnId, body }),
          "POST",
        )
      ).comment,
  };
};

/** Admin plane client (decision 13); every call carries the admin bearer. */
export const createAdminApi = (
  adminToken: () => string,
  doFetch: FetchLike = fetch,
): AdminApi => {
  const auth = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      authorization: `Bearer ${adminToken()}`,
    },
  });
  const authedJson = (method: string, body: unknown): RequestInit =>
    auth({
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const unwrap = async <T>(path: string, init: RequestInit): Promise<T> => {
    const res = await doFetch(path, init);
    if (!res.ok) throw new ApiError(res.status, path);
    return (await res.json()) as T;
  };
  return {
    users: async () =>
      (
        await unwrap<{ users: AdminUserRow[] }>(
          "/admin/users",
          auth({ method: "GET" }),
        )
      ).users,
    createUser: async (name, email) =>
      (
        await unwrap<{ user: AdminUserRow }>(
          "/admin/users",
          authedJson("POST", { name, email }),
        )
      ).user,
    setUserDisabled: async (name, disabled) => {
      await unwrap(
        `/admin/users/${encodeURIComponent(name)}`,
        authedJson("PATCH", { disabled }),
      );
    },
    setUserDri: async (name, isDri) => {
      await unwrap(
        `/admin/users/${encodeURIComponent(name)}`,
        authedJson("PATCH", { is_dri: isDri }),
      );
    },
    deleteUser: async (name) => {
      await unwrap(
        `/admin/users/${encodeURIComponent(name)}`,
        auth({ method: "DELETE" }),
      );
    },
    mintToken: async (name) =>
      unwrap<MintedToken>(
        `/admin/users/${encodeURIComponent(name)}/tokens`,
        auth({ method: "POST" }),
      ),
    tokens: async (name) =>
      (
        await unwrap<{ tokens: AdminTokenRow[] }>(
          `/admin/users/${encodeURIComponent(name)}/tokens`,
          auth({ method: "GET" }),
        )
      ).tokens,
    revokeToken: async (tokenId) => {
      await unwrap(
        `/admin/tokens/${encodeURIComponent(tokenId)}`,
        auth({ method: "DELETE" }),
      );
    },
    deleteSession: async (sessionId) => {
      await unwrap(
        `/admin/sessions/${encodeURIComponent(sessionId)}`,
        auth({ method: "DELETE" }),
      );
    },
    health: async () =>
      unwrap<AdminHealth>("/admin/health", auth({ method: "GET" })),
    quarantine: async (limit = 50) =>
      (
        await unwrap<{ rows: QuarantineRow[] }>(
          `/admin/quarantine?limit=${limit}`,
          auth({ method: "GET" }),
        )
      ).rows,
    teams: async () =>
      (
        await unwrap<{ teams: AdminTeamRow[] }>(
          "/admin/teams",
          auth({ method: "GET" }),
        )
      ).teams,
    settings: async () =>
      (
        await unwrap<{ settings: Record<string, string> }>(
          "/admin/settings",
          auth({ method: "GET" }),
        )
      ).settings,
    updateSettings: async (patch) => {
      await unwrap("/admin/settings", authedJson("PUT", patch));
    },
    testWebhook: async () => {
      await unwrap("/admin/webhook/test", auth({ method: "POST" }));
    },
    createTeam: async (name, rawRetentionDays) =>
      unwrap<{ team: AdminTeamRow }>(
        "/admin/teams",
        authedJson("POST", {
          name,
          ...(rawRetentionDays !== null
            ? { raw_retention_days: rawRetentionDays }
            : {}),
        }),
      ).then((r) => r.team),
    updateTeam: async (id, patch) => {
      await unwrap(
        `/admin/teams/${encodeURIComponent(id)}`,
        authedJson("PATCH", patch),
      );
    },
    deleteTeam: async (id) => {
      await unwrap(
        `/admin/teams/${encodeURIComponent(id)}`,
        auth({ method: "DELETE" }),
      );
    },
    setUserTeam: async (name, teamId) => {
      await unwrap(
        `/admin/users/${encodeURIComponent(name)}`,
        authedJson("PATCH", { team_id: teamId }),
      );
    },
  };
};
