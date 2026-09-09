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
  /** Decision 11: null out raw payloads older than the TTL. Returns rows touched. */
  pruneRawOlderThan(days: number): Promise<number>;
  /**
   * Rewrite each session's token columns with the full sum over its events.
   * The columns only accumulated events appended after they shipped, so
   * sessions captured before that undercount; idempotent, safe on a live DB.
   */
  backfillTokenTotals(): Promise<number>;
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
`;

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

    async close() {
      await pool.end();
    },
  };
};
