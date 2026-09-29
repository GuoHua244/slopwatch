import type { NormalEvent, QuarantineEvent } from "@slopwatch/events";
import { verifyAttachment, type AttachmentEvent } from "@slopwatch/events";
import { rollupDeltas, type FlatDelta, type ModelDelta } from "../rollups";
import { withTransaction, type PgCtx } from "./db";
import { recomputeRollups } from "./rollups";
import { SESSION_COLUMNS, pgSessionRow } from "./rows";
import type { Store } from "./types";

/** Raw rows nulled per pruneRaw sweep — bounds the per-run transaction size. */
const PRUNE_RAW_BATCH = 200;

export const sessionMethods = (
  ctx: PgCtx,
): Pick<
  Store,
  | "appendEvents"
  | "listSessions"
  | "eventsSince"
  | "getAttachment"
  | "sessionOwner"
  | "deleteSession"
  | "pruneRaw"
  | "backfillTokenTotals"
  | "backfillResponseText"
  | "getSession"
> => {
  const { pool } = ctx;
  return {
    async appendEvents(events, userId) {
      if (events.length === 0) return { accepted: 0 };
      // v2 decision 21: quarantine events bypass the event log entirely —
      // they record lines that could not be normalized, not session history.
      // Attachment events likewise stay out of the log: their bytes land in
      // the attachments table and the referencing turn/tool payloads hold
      // only the sha refs.
      const normal = events.filter(
        (e): e is Exclude<NormalEvent, QuarantineEvent> =>
          e.kind !== "quarantine",
      );
      const quarantined = events.filter(
        (e): e is QuarantineEvent => e.kind === "quarantine",
      );
      const attachments = normal.filter(
        (e): e is AttachmentEvent => e.kind === "attachment",
      );
      const logged = normal.filter((e) => e.kind !== "attachment");
      return withTransaction(pool, async (client) => {
        for (const event of quarantined) {
          await client.query(
            "INSERT INTO quarantine (agent, session_id, reason, line, occurred_at) VALUES ($1, $2, $3, $4, $5)",
            [
              event.agent,
              event.session_id,
              event.reason,
              event.line,
              event.occurred_at,
            ],
          );
        }
        const bySession = new Map<string, NormalEvent[]>();
        for (const event of logged) {
          const group = bySession.get(event.session_id) ?? [];
          group.push(event);
          bySession.set(event.session_id, group);
        }
        const attachmentsBySession = new Map<string, AttachmentEvent[]>();
        for (const event of attachments) {
          const group = attachmentsBySession.get(event.session_id) ?? [];
          group.push(event);
          attachmentsBySession.set(event.session_id, group);
        }
        // attachment-only batches still create their session row — the FK
        // demands it and a lone image is still a session's evidence
        for (const [sessionId, group] of attachmentsBySession) {
          if (!bySession.has(sessionId)) bySession.set(sessionId, []);
        }
        // ADR 0004: the creating user's team AT INGEST TIME is snapshotted
        // onto a new session; reassignments never move captured history.
        let ingestTeamId: string | null = null;
        if (userId !== null) {
          const owned = await client.query(
            "SELECT team_id FROM users WHERE name = $1",
            [userId],
          );
          ingestTeamId = (owned.rows[0]?.team_id as string | null) ?? null;
        }
        for (const [sessionId, group] of bySession) {
          const agent =
            group[0]?.agent ?? attachmentsBySession.get(sessionId)![0]!.agent;
          await client.query(
            "INSERT INTO sessions (session_id, agent, user_id, team_id) VALUES ($1, $2, $3, $4) ON CONFLICT (session_id) DO NOTHING",
            [sessionId, agent, userId, ingestTeamId],
          );
          // row lock on the session serializes concurrent writers
          const { rows } = await client.query(
            "UPDATE sessions SET last_seq = last_seq + $2, last_event_at = now() WHERE session_id = $1 RETURNING last_seq",
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
            if (
              event.kind === "session" &&
              event.event === "start" &&
              event.parent_session_id
            ) {
              await client.query(
                "UPDATE sessions SET parent_session_id = $2 WHERE session_id = $1 AND parent_session_id IS NULL",
                [sessionId, event.parent_session_id],
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
          // Captured images, content-addressed per session. Content
          // addressing is earned, not claimed: a payload that does not decode
          // to its declared size and hash is corruption — skip it and the
          // dashboard's "not archived" fallback shows in its place.
          for (const attachment of attachmentsBySession.get(sessionId) ?? []) {
            if (!verifyAttachment(attachment)) continue;
            await client.query(
              `INSERT INTO attachments (session_id, sha256, origin, mime, size, data)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (session_id, sha256) DO NOTHING`,
              [
                sessionId,
                attachment.sha256,
                attachment.origin,
                attachment.mime,
                attachment.size,
                Buffer.from(attachment.data, "base64"),
              ],
            );
          }
        }
        // Decision 18: fold the batch into the usage rollups in the same
        // transaction, so the aggregates can never drift from the events.
        if (userId !== null && logged.length > 0) {
          const rollupUser: string = userId;
          const deltas = rollupDeltas(logged);
          const bumpFlatRollup = async (
            table: "user_daily_rollup" | "user_hourly_rollup",
            column: "day" | "hour",
            byBucket: Map<string, FlatDelta>,
          ) => {
            for (const [bucket, d] of byBucket) {
              if (d.turns === 0 && d.toolCalls === 0) continue;
              await client.query(
                `INSERT INTO ${table} (user_id, ${column}, turns, tool_calls)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (user_id, ${column}) DO UPDATE SET
                   turns = ${table}.turns + EXCLUDED.turns,
                   tool_calls = ${table}.tool_calls + EXCLUDED.tool_calls`,
                [rollupUser, bucket, d.turns, d.toolCalls],
              );
            }
          };
          await bumpFlatRollup("user_daily_rollup", "day", deltas.daily);
          await bumpFlatRollup("user_hourly_rollup", "hour", deltas.hourly);
          const upsertModelRollup = async (
            table: "model_daily_rollup" | "model_hourly_rollup",
            column: "day" | "hour",
            byModel: Map<string, Map<string, ModelDelta>>,
          ) => {
            for (const [bucket, models] of byModel) {
              for (const [model, d] of models) {
                await client.query(
                  `INSERT INTO ${table} (user_id, ${column}, model, model_requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                   ON CONFLICT (user_id, ${column}, model) DO UPDATE SET
                     model_requests = ${table}.model_requests + EXCLUDED.model_requests,
                     input_tokens = ${table}.input_tokens + EXCLUDED.input_tokens,
                     output_tokens = ${table}.output_tokens + EXCLUDED.output_tokens,
                     cache_read_tokens = ${table}.cache_read_tokens + EXCLUDED.cache_read_tokens,
                     cache_write_tokens = ${table}.cache_write_tokens + EXCLUDED.cache_write_tokens`,
                  [
                    rollupUser,
                    bucket,
                    model,
                    d.modelRequests,
                    d.inputTokens,
                    d.outputTokens,
                    d.cacheReadTokens,
                    d.cacheWriteTokens,
                  ],
                );
              }
            }
          };
          await upsertModelRollup(
            "model_daily_rollup",
            "day",
            deltas.modelDaily,
          );
          await upsertModelRollup(
            "model_hourly_rollup",
            "hour",
            deltas.modelHourly,
          );
        }
        return { accepted: events.length };
      });
    },

    async listSessions(teamId, userId) {
      const filters: string[] = [];
      const args: unknown[] = [];
      // Team scope mirrors the leaderboard (v2 decision 27): membership
      // resolves through users.team_id — the owner's current team — so the
      // rail filter and the leaderboard group people identically. The
      // sessions.team_id ingest snapshot (ADR 0004) stays reserved for
      // retention attribution.
      if (teamId !== undefined) {
        if (teamId === "unassigned")
          filters.push(
            "user_id NOT IN (SELECT name FROM users WHERE team_id IS NOT NULL)",
          );
        else {
          args.push(teamId);
          filters.push(
            `user_id IN (SELECT name FROM users WHERE team_id = $${args.length})`,
          );
        }
      }
      if (userId !== undefined) {
        args.push(userId);
        filters.push(`user_id = $${args.length}`);
      }
      const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
      // Hard cap: the dashboard polls this every 5s and groups client-side;
      // newest-wins keeps the working set relevant and bounds payload/scan.
      const { rows } = await pool.query(
        `SELECT ${SESSION_COLUMNS} FROM sessions ${where} ORDER BY COALESCE(last_event_at, first_seen_at) DESC LIMIT 1000`,
        args,
      );
      return rows.map((r) => pgSessionRow(r));
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

    async getAttachment(sessionId, sha256) {
      const { rows } = await pool.query(
        "SELECT mime, data FROM attachments WHERE session_id = $1 AND sha256 = $2",
        [sessionId, sha256],
      );
      if (rows.length === 0) return null;
      return { mime: rows[0]!.mime as string, data: rows[0]!.data as Buffer };
    },

    async pruneRaw({ defaultDays, archive }) {
      // effective TTL = the session's own team snapshot (ADR 0004: attribution
      // is frozen at ingest, so a later team move must not re-scope history),
      // falling back to the owner's current team for legacy sessions that
      // predate the snapshot, else the global default
      const candidates = await pool.query(
        `SELECT e.session_id, e.event_seq, e.agent, e.raw
        FROM events e
        JOIN sessions s ON s.session_id = e.session_id
        LEFT JOIN users u ON u.name = s.user_id
        LEFT JOIN teams t ON t.id = COALESCE(s.team_id, u.team_id)
        WHERE e.raw IS NOT NULL
          AND e.received_at < now() - make_interval(days => COALESCE(t.raw_retention_days, $1))
        LIMIT $2`,
        [defaultDays, PRUNE_RAW_BATCH],
      );
      let archived = 0;
      let pruned = 0;
      for (const row of candidates.rows) {
        const sessionId = row.session_id as string;
        const seq = Number(row.event_seq);
        const key = `raw/${row.agent}/${sessionId}/${seq}.json`;
        if (archive) {
          try {
            await archive.putObject(key, JSON.stringify(row.raw));
          } catch {
            continue; // keep the row; the next run retries the upload
          }
        }
        await pool.query(
          "UPDATE events SET raw = NULL, raw_archived = $3, archive_key = $4 WHERE session_id = $1 AND event_seq = $2",
          [
            sessionId,
            seq,
            archive !== undefined,
            archive !== undefined ? key : null,
          ],
        );
        if (archive !== undefined) archived += 1;
        pruned += 1;
      }
      return { archived, pruned };
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

    async backfillResponseText() {
      const { rowCount } = await pool.query(`
        UPDATE events
        SET payload = payload
          || jsonb_build_object('response_text', left(raw#>>'{response,text}', 2000))
        WHERE kind = 'model_request'
          AND agent = 'zcode'
          AND raw IS NOT NULL
          -- title-generation requests echo a JSON title payload, not speech
          AND (raw->>'querySource') IS DISTINCT FROM 'session_title'
          AND jsonb_typeof(raw#>'{response,text}') = 'string'
          AND length(raw#>>'{response,text}') > 0
          AND payload->>'response_text' IS NULL
      `);
      return rowCount ?? 0;
    },

    async deleteSession(sessionId) {
      return withTransaction(pool, async (client) => {
        const owner = await client.query(
          "SELECT user_id FROM sessions WHERE session_id = $1",
          [sessionId],
        );
        await client.query("DELETE FROM events WHERE session_id = $1", [
          sessionId,
        ]);
        const session = await client.query(
          "DELETE FROM sessions WHERE session_id = $1",
          [sessionId],
        );
        if ((session.rowCount ?? 0) > 0) {
          // Rollups keep summing the sessions that remain.
          const userId = owner.rows[0]?.user_id;
          if (typeof userId === "string")
            await recomputeRollups(client, userId);
        }
        return (session.rowCount ?? 0) > 0;
      });
    },

    async sessionOwner(sessionId) {
      const { rows } = await pool.query(
        "SELECT user_id FROM sessions WHERE session_id = $1",
        [sessionId],
      );
      return (rows[0]?.user_id as string | null | undefined) ?? null;
    },

    async getSession(sessionId) {
      const { rows } = await pool.query(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE session_id = $1`,
        [sessionId],
      );
      return rows[0] ? pgSessionRow(rows[0]) : null;
    },
  };
};
