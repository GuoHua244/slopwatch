import { createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";
import type { NormalEvent } from "@slopwatch/events";

export type SessionRow = {
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

export type StoredEvent = { event_seq: number; event: NormalEvent };

/** Row of GET /admin/users (decision 13). */
export type AdminUserRow = {
  name: string;
  email: string | null;
  disabled: boolean;
  is_dri: boolean;
  created_at: string;
  active_tokens: number;
};

/** Row of GET /admin/users/:name/tokens — the plaintext is never stored. */
export type AdminTokenRow = {
  token_id: string;
  hint: string;
  created_at: string;
  revoked_at: string | null;
};

/** The accountability marker (decision 10): one review per session, latest wins. */
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

export type HealthInfo = {
  sessions: number;
  events: number;
  last_event_at: string | null;
};

/** Thrown when a unique user name collides (HTTP 409). */
export class UserExistsError extends Error {
  constructor(name: string) {
    super(`user "${name}" already exists`);
    this.name = "UserExistsError";
  }
}

/** Bearer tokens are stored only as SHA-256 hashes (decision 6). */
export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const mintTokenValue = (): { token: string; hash: string; hint: string } => {
  const token = `sw_${randomBytes(24).toString("hex")}`;
  return { token, hash: hashToken(token), hint: token.slice(0, 10) };
};

export type Store = {
  /** Create tables if missing. Idempotent. */
  migrate(): Promise<void>;
  /** Persist a batch, assigning a per-session monotonic event_seq. */
  appendEvents(
    events: NormalEvent[],
    userId: string | null,
  ): Promise<{ accepted: number }>;
  listSessions(): Promise<SessionRow[]>;
  eventsSince(sessionId: string, sinceSeq: number): Promise<StoredEvent[]>;
  /**
   * Decision 13: remove a whole session — normalized events, raw payloads,
   * and the row itself. The leak-remediation action. False when absent.
   */
  deleteSession(sessionId: string): Promise<boolean>;
  /** Decision 11: null out raw payloads older than the TTL. Returns rows touched. */
  pruneRawOlderThan(days: number): Promise<number>;
  /**
   * Rewrite each session's token columns with the full sum over its events.
   * The columns only accumulated events appended after they shipped, so
   * sessions captured before that undercount; idempotent, safe on a live DB.
   */
  backfillTokenTotals(): Promise<number>;
  /** Decision 13 admin plane. */
  createUser(name: string, email: string | null): Promise<AdminUserRow>;
  getUser(name: string): Promise<AdminUserRow | null>;
  listUsers(): Promise<AdminUserRow[]>;
  setUserDisabled(
    name: string,
    disabled: boolean,
  ): Promise<AdminUserRow | null>;
  deleteUser(name: string): Promise<boolean>;
  /** Mint a bearer token; the plaintext appears exactly once, in the return. */
  mintToken(
    userName: string,
  ): Promise<{ token_id: string; hint: string; token: string }>;
  listTokens(userName: string): Promise<AdminTokenRow[]>;
  revokeToken(tokenId: string): Promise<boolean>;
  /** Bearer token → user name; null for unknown, revoked, or disabled. */
  resolveTokenUser(token: string): Promise<string | null>;
  /** Decision 10: mark a session reviewed (upsert). Null when the session is unknown. */
  markReviewed(
    sessionId: string,
    reviewerId: string,
  ): Promise<ReviewRow | null>;
  /** Decision 10: retract a review. False when no review (or session) exists. */
  unmarkReviewed(sessionId: string): Promise<boolean>;
  reviewFor(sessionId: string): Promise<ReviewRow | null>;
  /** Add a review note. Null when the session is unknown. */
  addComment(
    sessionId: string,
    turnId: string | null,
    authorId: string,
    body: string,
  ): Promise<CommentRow | null>;
  listComments(sessionId: string): Promise<CommentRow[]>;
  /** Decision 10: the DRI role attribute. False for unknown users. */
  isDri(name: string): Promise<boolean>;
  setUserDri(name: string, isDri: boolean): Promise<AdminUserRow | null>;
  health(): Promise<HealthInfo>;
  close(): Promise<void>;
};

const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  agent         TEXT NOT NULL,
  user_id       TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seq      BIGINT NOT NULL DEFAULT 0,
  title         TEXT,
  task_preview  TEXT,
  total_input_tokens       BIGINT NOT NULL DEFAULT 0,
  total_output_tokens      BIGINT NOT NULL DEFAULT 0,
  total_cache_read_tokens  BIGINT NOT NULL DEFAULT 0,
  total_cache_write_tokens BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  session_id  TEXT NOT NULL REFERENCES sessions (session_id),
  event_seq   BIGINT NOT NULL,
  agent       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  payload     JSONB NOT NULL,
  raw         JSONB,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, event_seq)
);
CREATE INDEX IF NOT EXISTS events_received_at ON events (received_at);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS task_preview TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_input_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_output_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_cache_read_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_cache_write_tokens BIGINT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS users (
  name       TEXT PRIMARY KEY,
  email      TEXT,
  disabled   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tokens (
  token_id   UUID PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  hint       TEXT NOT NULL,
  user_name  TEXT NOT NULL REFERENCES users (name) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_dri BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS session_reviews (
  session_id  TEXT PRIMARY KEY REFERENCES sessions (session_id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS review_comments (
  comment_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
  turn_id    TEXT,
  author_id  TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS review_comments_session ON review_comments (session_id);
`;

const pgUserRow = (r: Record<string, unknown>): AdminUserRow => ({
  name: r.name as string,
  email: (r.email as string | null) ?? null,
  disabled: r.disabled === true,
  is_dri: r.is_dri === true,
  created_at: new Date(r.created_at as string).toISOString(),
  active_tokens: Number(r.active_tokens ?? 0),
});

const pgReviewRow = (r: Record<string, unknown>): ReviewRow => ({
  session_id: r.session_id as string,
  reviewer_id: r.reviewer_id as string,
  reviewed_at: new Date(r.reviewed_at as string).toISOString(),
});

const pgCommentRow = (r: Record<string, unknown>): CommentRow => ({
  comment_id: Number(r.comment_id),
  session_id: r.session_id as string,
  turn_id: (r.turn_id as string | null) ?? null,
  author_id: r.author_id as string,
  body: r.body as string,
  created_at: new Date(r.created_at as string).toISOString(),
});

export const createPgStore = (databaseUrl: string): Store => {
  const pool = new Pool({ connectionString: databaseUrl });

  return {
    async migrate() {
      await pool.query(DDL);
    },

    async appendEvents(events, userId) {
      if (events.length === 0) return { accepted: 0 };
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const bySession = new Map<string, NormalEvent[]>();
        for (const event of events) {
          const group = bySession.get(event.session_id) ?? [];
          group.push(event);
          bySession.set(event.session_id, group);
        }
        for (const [sessionId, group] of bySession) {
          await client.query(
            "INSERT INTO sessions (session_id, agent, user_id) VALUES ($1, $2, $3) ON CONFLICT (session_id) DO NOTHING",
            [sessionId, group[0]!.agent, userId],
          );
          // row lock on the session serializes concurrent writers
          const { rows } = await client.query(
            "UPDATE sessions SET last_seq = last_seq + $2 WHERE session_id = $1 RETURNING last_seq",
            [sessionId, group.length],
          );
          let seq = Number(rows[0]!.last_seq) - group.length;
          let dIn = 0;
          let dOut = 0;
          let dCacheRead = 0;
          let dCacheWrite = 0;
          for (const event of group) {
            seq += 1;
            const { raw, ...payload } = event;
            await client.query(
              "INSERT INTO events (session_id, event_seq, agent, kind, payload, raw) VALUES ($1, $2, $3, $4, $5, $6)",
              [
                sessionId,
                seq,
                event.agent,
                event.kind,
                JSON.stringify(payload),
                raw === undefined ? null : JSON.stringify(raw),
              ],
            );
            if (event.kind === "session" && event.event === "meta") {
              await client.query(
                "UPDATE sessions SET title = COALESCE($2, title), task_preview = COALESCE($3, task_preview) WHERE session_id = $1",
                [sessionId, event.title ?? null, event.task_preview ?? null],
              );
            }
            if (event.kind === "model_request" && event.usage) {
              dIn += event.usage.input_tokens ?? 0;
              dOut += event.usage.output_tokens ?? 0;
              dCacheRead += event.usage.cache_read_tokens ?? 0;
              dCacheWrite += event.usage.cache_write_tokens ?? 0;
            }
          }
          if (dIn || dOut || dCacheRead || dCacheWrite) {
            await client.query(
              "UPDATE sessions SET total_input_tokens = total_input_tokens + $2, total_output_tokens = total_output_tokens + $3, total_cache_read_tokens = total_cache_read_tokens + $4, total_cache_write_tokens = total_cache_write_tokens + $5 WHERE session_id = $1",
              [sessionId, dIn, dOut, dCacheRead, dCacheWrite],
            );
          }
        }
        await client.query("COMMIT");
        return { accepted: events.length };
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },

    async listSessions() {
      const { rows } = await pool.query(
        "SELECT session_id, agent, user_id, first_seen_at, last_seq, title, task_preview, total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_write_tokens FROM sessions ORDER BY first_seen_at DESC",
      );
      return rows.map((r) => ({
        session_id: r.session_id as string,
        agent: r.agent as string,
        user_id: r.user_id as string | null,
        first_seen_at: new Date(r.first_seen_at as string).toISOString(),
        last_seq: Number(r.last_seq),
        title: (r.title as string | null) ?? null,
        task_preview: (r.task_preview as string | null) ?? null,
        total_input_tokens: Number(r.total_input_tokens),
        total_output_tokens: Number(r.total_output_tokens),
        total_cache_read_tokens: Number(r.total_cache_read_tokens),
        total_cache_write_tokens: Number(r.total_cache_write_tokens),
      }));
    },

    async eventsSince(sessionId, sinceSeq) {
      const { rows } = await pool.query(
        "SELECT event_seq, payload FROM events WHERE session_id = $1 AND event_seq > $2 ORDER BY event_seq ASC LIMIT 1000",
        [sessionId, sinceSeq],
      );
      return rows.map((r) => ({
        event_seq: Number(r.event_seq),
        event: r.payload as NormalEvent,
      }));
    },

    async pruneRawOlderThan(days) {
      const { rowCount } = await pool.query(
        "UPDATE events SET raw = NULL WHERE raw IS NOT NULL AND received_at < now() - ($1 || ' days')::interval",
        [days],
      );
      return rowCount ?? 0;
    },

    async backfillTokenTotals() {
      const { rowCount } = await pool.query(`
        UPDATE sessions s SET
          total_input_tokens = COALESCE(a.i, 0),
          total_output_tokens = COALESCE(a.o, 0),
          total_cache_read_tokens = COALESCE(a.cr, 0),
          total_cache_write_tokens = COALESCE(a.cw, 0)
        FROM (
          SELECT session_id,
                 SUM((payload->'usage'->>'input_tokens')::bigint)      AS i,
                 SUM((payload->'usage'->>'output_tokens')::bigint)     AS o,
                 SUM((payload->'usage'->>'cache_read_tokens')::bigint)  AS cr,
                 SUM((payload->'usage'->>'cache_write_tokens')::bigint) AS cw
          FROM events
          WHERE kind = 'model_request'
          GROUP BY session_id
        ) a
        WHERE s.session_id = a.session_id
      `);
      return rowCount ?? 0;
    },

    async deleteSession(sessionId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM events WHERE session_id = $1", [
          sessionId,
        ]);
        const session = await client.query(
          "DELETE FROM sessions WHERE session_id = $1",
          [sessionId],
        );
        await client.query("COMMIT");
        return (session.rowCount ?? 0) > 0;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },

    async createUser(name, email) {
      try {
        const { rows } = await pool.query(
          "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING name, email, disabled, created_at",
          [name, email],
        );
        return pgUserRow(rows[0]!);
      } catch (e) {
        if ((e as { code?: string }).code === "23505")
          throw new UserExistsError(name);
        throw e;
      }
    },

    async getUser(name) {
      const { rows } = await pool.query(
        "SELECT name, email, disabled, created_at FROM users WHERE name = $1",
        [name],
      );
      return rows[0] ? pgUserRow(rows[0]) : null;
    },

    async listUsers() {
      const { rows } = await pool.query(`
        SELECT u.name, u.email, u.disabled, u.is_dri, u.created_at,
               COUNT(t.token_id) FILTER (WHERE t.revoked_at IS NULL) AS active_tokens
        FROM users u LEFT JOIN tokens t ON t.user_name = u.name
        GROUP BY u.name, u.email, u.disabled, u.is_dri, u.created_at
        ORDER BY u.created_at ASC
      `);
      return rows.map((r) => pgUserRow(r));
    },

    async setUserDri(name, isDri) {
      const { rows } = await pool.query(
        "UPDATE users SET is_dri = $2 WHERE name = $1 RETURNING name, email, disabled, is_dri, created_at",
        [name, isDri],
      );
      return rows[0] ? pgUserRow(rows[0]) : null;
    },

    async setUserDisabled(name, disabled) {
      const { rows } = await pool.query(
        "UPDATE users SET disabled = $2 WHERE name = $1 RETURNING name, email, disabled, created_at",
        [name, disabled],
      );
      return rows[0] ? pgUserRow(rows[0]) : null;
    },

    async deleteUser(name) {
      const { rowCount } = await pool.query(
        "DELETE FROM users WHERE name = $1",
        [name],
      );
      return (rowCount ?? 0) > 0;
    },

    async mintToken(userName) {
      const { token, hash, hint } = mintTokenValue();
      const { rows } = await pool.query(
        "INSERT INTO tokens (token_id, token_hash, hint, user_name) VALUES ($1, $2, $3, $4) RETURNING token_id",
        [crypto.randomUUID(), hash, hint, userName],
      );
      return { token_id: rows[0]!.token_id as string, hint, token };
    },

    async listTokens(userName) {
      const { rows } = await pool.query(
        "SELECT token_id, hint, created_at, revoked_at FROM tokens WHERE user_name = $1 ORDER BY created_at ASC",
        [userName],
      );
      return rows.map((r) => ({
        token_id: r.token_id as string,
        hint: r.hint as string,
        created_at: new Date(r.created_at as string).toISOString(),
        revoked_at: r.revoked_at
          ? new Date(r.revoked_at as string).toISOString()
          : null,
      }));
    },

    async revokeToken(tokenId) {
      const { rowCount } = await pool.query(
        "UPDATE tokens SET revoked_at = now() WHERE token_id = $1 AND revoked_at IS NULL",
        [tokenId],
      );
      return (rowCount ?? 0) > 0;
    },

    async resolveTokenUser(token) {
      const { rows } = await pool.query(
        `SELECT t.user_name FROM tokens t
         JOIN users u ON u.name = t.user_name
         WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND NOT u.disabled`,
        [hashToken(token)],
      );
      return (rows[0]?.user_name as string | undefined) ?? null;
    },

    async markReviewed(sessionId, reviewerId) {
      try {
        const { rows } = await pool.query(
          `INSERT INTO session_reviews (session_id, reviewer_id) VALUES ($1, $2)
         ON CONFLICT (session_id) DO UPDATE
           SET reviewer_id = EXCLUDED.reviewer_id, reviewed_at = now()
         RETURNING session_id, reviewer_id, reviewed_at`,
          [sessionId, reviewerId],
        );
        return pgReviewRow(rows[0]!);
      } catch (e) {
        if ((e as { code?: string }).code === "23503") return null; // no such session
        throw e;
      }
    },

    async unmarkReviewed(sessionId) {
      const { rowCount } = await pool.query(
        "DELETE FROM session_reviews WHERE session_id = $1",
        [sessionId],
      );
      return (rowCount ?? 0) > 0;
    },

    async reviewFor(sessionId) {
      const { rows } = await pool.query(
        "SELECT session_id, reviewer_id, reviewed_at FROM session_reviews WHERE session_id = $1",
        [sessionId],
      );
      return rows[0] ? pgReviewRow(rows[0]) : null;
    },

    async addComment(sessionId, turnId, authorId, body) {
      try {
        const { rows } = await pool.query(
          "INSERT INTO review_comments (session_id, turn_id, author_id, body) VALUES ($1, $2, $3, $4) RETURNING comment_id, session_id, turn_id, author_id, body, created_at",
          [sessionId, turnId, authorId, body],
        );
        return pgCommentRow(rows[0]!);
      } catch (e) {
        if ((e as { code?: string }).code === "23503") return null; // no such session
        throw e;
      }
    },

    async listComments(sessionId) {
      const { rows } = await pool.query(
        "SELECT comment_id, session_id, turn_id, author_id, body, created_at FROM review_comments WHERE session_id = $1 ORDER BY created_at ASC, comment_id ASC",
        [sessionId],
      );
      return rows.map((r) => pgCommentRow(r));
    },

    async isDri(name) {
      const { rows } = await pool.query(
        "SELECT is_dri FROM users WHERE name = $1",
        [name],
      );
      return rows[0]?.is_dri === true;
    },

    async health() {
      const { rows } = await pool.query(
        "SELECT (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM events) AS events, (SELECT MAX(received_at) FROM events) AS last_event_at",
      );
      return {
        sessions: Number(rows[0]!.sessions),
        events: Number(rows[0]!.events),
        last_event_at: rows[0]!.last_event_at
          ? new Date(rows[0]!.last_event_at as string).toISOString()
          : null,
      };
    },

    async close() {
      await pool.end();
    },
  };
};
