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

/**
 * Minimal fetch surface the client needs (string URL in, Response out).
 * The global fetch satisfies it; tests inject stubs.
 */
export type FetchLike = (input: string) => Promise<Response>;

const getJson = async <T>(doFetch: FetchLike, path: string): Promise<T> => {
  const res = await doFetch(path);
  if (!res.ok) throw new ApiError(res.status, path);
  return (await res.json()) as T;
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
