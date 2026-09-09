import { Pool } from "pg";
import type { NormalEvent } from "@slopwatch/events";

export type SessionRow = {
  session_id: string;
  agent: string;
  user_id: string | null;
  first_seen_at: string;
  last_seq: number;
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
  close(): Promise<void>;
};

const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  agent         TEXT NOT NULL,
  user_id       TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seq      BIGINT NOT NULL DEFAULT 0
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
        "SELECT session_id, agent, user_id, first_seen_at, last_seq FROM sessions ORDER BY first_seen_at DESC",
      );
      return rows.map((r) => ({
        session_id: r.session_id as string,
        agent: r.agent as string,
        user_id: r.user_id as string | null,
        first_seen_at: new Date(r.first_seen_at as string).toISOString(),
        last_seq: Number(r.last_seq),
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

    async close() {
      await pool.end();
    },
  };
};
