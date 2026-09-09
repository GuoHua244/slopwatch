import type { NormalEvent } from "@slopwatch/events";

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

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`GET ${path} failed with ${status}`);
    this.name = "ApiError";
  }
}

export type Api = {
  listSessions(): Promise<SessionSummary[]>;
  /** Decision 8: incremental page of a session's events after sinceSeq. */
  eventsSince(sessionId: string, sinceSeq: number): Promise<StoredEvent[]>;
};

/** Row of GET /admin/users — mirrors the Server's AdminUserRow. */
export type AdminUserRow = {
  name: string;
  email: string | null;
  disabled: boolean;
  created_at: string;
  active_tokens: number;
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

export type AdminHealth = {
  ok: boolean;
  sessions: number;
  events: number;
  last_event_at: string | null;
};

export type AdminApi = {
  users(): Promise<AdminUserRow[]>;
  createUser(name: string, email: string | null): Promise<AdminUserRow>;
  setUserDisabled(name: string, disabled: boolean): Promise<void>;
  deleteUser(name: string): Promise<void>;
  mintToken(name: string): Promise<MintedToken>;
  tokens(name: string): Promise<AdminTokenRow[]>;
  revokeToken(tokenId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  health(): Promise<AdminHealth>;
};

/**
 * Minimal fetch surface the client needs (string URL in, Response out).
 * The global fetch satisfies it; tests inject stubs.
 */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

const getJson = async <T>(doFetch: FetchLike, path: string): Promise<T> => {
  const res = await doFetch(path);
  if (!res.ok) throw new ApiError(res.status, path);
  return (await res.json()) as T;
};

const sendJson = async (
  doFetch: FetchLike,
  path: string,
  init: RequestInit,
): Promise<Response> => {
  const res = await doFetch(path, init);
  if (!res.ok) throw new ApiError(res.status, path);
  return res;
};

/** Dashboard client over the Server's read-only endpoints (same-origin). */
export const createApi = (doFetch: FetchLike = fetch): Api => ({
  listSessions: async () =>
    (await getJson<{ sessions: SessionSummary[] }>(doFetch, "/sessions"))
      .sessions,
  eventsSince: async (sessionId, sinceSeq) =>
    (
      await getJson<{ events: StoredEvent[] }>(
        doFetch,
        `/sessions/${encodeURIComponent(sessionId)}/events?since_seq=${sinceSeq}`,
      )
    ).events,
});

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
  };
};
