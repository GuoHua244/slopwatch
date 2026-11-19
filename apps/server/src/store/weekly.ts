import type { PgCtx } from "./db";
import { iso } from "./rows";
import type { Store, WeeklyReportRow } from "./types";

/**
 * v3 decision 36: the team weekly report's store face — the two week-scan
 * queries the data assembly needs beyond the rollups, and the report rows
 * themselves (the retros' snapshot discipline: data + prompt ride along).
 */
export const weeklyMethods = (
  ctx: PgCtx,
): Pick<
  Store,
  | "topSessionsByTokens"
  | "commitsSince"
  | "addWeeklyReport"
  | "listWeeklyReports"
> => {
  const { pool } = ctx;
  return {
    async topSessionsByTokens({ sinceDay, untilDay, teamId, limit }) {
      // `untilDay` is exclusive — the window's [since, until) spans whole
      // UTC days without time-of-day arithmetic.
      const params: unknown[] = [
        `${sinceDay}T00:00:00Z`,
        `${untilDay}T00:00:00Z`,
      ];
      if (teamId !== undefined) params.push(teamId);
      const filter =
        teamId === undefined ? "" : ` AND u.team_id = $${params.length}`;
      const { rows } = await pool.query(
        `SELECT e.session_id, s.title, s.user_id, s.agent,
                SUM(
                  COALESCE((e.payload->'usage'->>'input_tokens')::bigint, 0)
                  + COALESCE((e.payload->'usage'->>'output_tokens')::bigint, 0)
                  + COALESCE((e.payload->'usage'->>'cache_read_tokens')::bigint, 0)
                  + COALESCE((e.payload->'usage'->>'cache_write_tokens')::bigint, 0)
                ) AS tokens
         FROM events e
         JOIN sessions s ON s.session_id = e.session_id
         LEFT JOIN users u ON u.name = s.user_id
         WHERE e.kind = 'model_request'
           AND (e.payload->>'occurred_at')::timestamptz >= $1::timestamptz
           AND (e.payload->>'occurred_at')::timestamptz < $2::timestamptz
           ${filter}
         GROUP BY e.session_id, s.title, s.user_id, s.agent
         ORDER BY tokens DESC
         LIMIT $${params.length + 1}`,
        [...params, limit],
      );
      return rows.map((r) => ({
        session_id: r.session_id as string,
        title: (r.title as string | null) ?? null,
        user_id: (r.user_id as string | null) ?? null,
        agent: r.agent as string,
        tokens: Number(r.tokens),
      }));
    },

    async commitsSince({ sinceDay, untilDay, teamId, limit }) {
      const params: unknown[] = [
        `${sinceDay}T00:00:00Z`,
        `${untilDay}T00:00:00Z`,
      ];
      if (teamId !== undefined) params.push(teamId);
      const filter =
        teamId === undefined ? "" : ` AND u.team_id = $${params.length}`;
      const { rows } = await pool.query(
        `SELECT c.sha, c.subject, c.occurred_at, s.user_id
         FROM session_commits c
         JOIN sessions s ON s.session_id = c.session_id
         LEFT JOIN users u ON u.name = s.user_id
         WHERE c.occurred_at >= $1::timestamptz
           AND c.occurred_at < $2::timestamptz
           ${filter}
         ORDER BY c.occurred_at DESC
         LIMIT $${params.length + 1}`,
        [...params, limit],
      );
      return rows.map((r) => ({
        sha: (r.sha as string | null) ?? null,
        subject: (r.subject as string | null) ?? null,
        user_id: (r.user_id as string | null) ?? null,
        occurred_at: iso(r.occurred_at),
      }));
    },

    async addWeeklyReport(row) {
      const { rows } = await pool.query(
        `INSERT INTO weekly_reports (
           requested_by, team_id, since_day, until_day,
           data_snapshot, prompt_snapshot, status, result, model,
           input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, error
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          row.requested_by,
          row.team_id,
          row.since_day,
          row.until_day,
          row.data_snapshot,
          row.prompt_snapshot,
          row.status,
          row.result,
          row.model,
          row.input_tokens,
          row.output_tokens,
          row.cache_read_tokens,
          row.reasoning_tokens,
          row.error,
        ],
      );
      return pgWeeklyReportRow(rows[0]!);
    },

    async listWeeklyReports(limit) {
      const { rows } = await pool.query(
        `SELECT * FROM weekly_reports ORDER BY created_at DESC, id DESC LIMIT $1`,
        [limit],
      );
      return rows.map(pgWeeklyReportRow);
    },
  };
};

/** data_snapshot and prompt_snapshot ride in the row but reads omit them —
 * a report list is a list of results, not a prompt archive. */
const pgWeeklyReportRow = (r: Record<string, unknown>): WeeklyReportRow => ({
  id: Number(r.id),
  requested_by: r.requested_by as string,
  team_id: (r.team_id as string | null) ?? null,
  since_day: r.since_day as string,
  until_day: r.until_day as string,
  status: r.status === "failed" ? "failed" : "completed",
  result: (r.result as string | null) ?? null,
  model: (r.model as string | null) ?? null,
  input_tokens:
    r.input_tokens === null || r.input_tokens === undefined
      ? null
      : Number(r.input_tokens),
  output_tokens:
    r.output_tokens === null || r.output_tokens === undefined
      ? null
      : Number(r.output_tokens),
  cache_read_tokens:
    r.cache_read_tokens === null || r.cache_read_tokens === undefined
      ? null
      : Number(r.cache_read_tokens),
  reasoning_tokens:
    r.reasoning_tokens === null || r.reasoning_tokens === undefined
      ? null
      : Number(r.reasoning_tokens),
  error: (r.error as string | null) ?? null,
  created_at: iso(r.created_at),
});
