import type { PgCtx } from "./db";
import type { Store } from "./types";

/**
 * v3 decision 33: the read helpers the threshold checker runs against the
 * store. Kept here rather than inlined in alerts.ts so they are ordinary
 * store methods — testable against Postgres, scripted in the HTTP tests.
 */
export const alertMethods = (
  ctx: PgCtx,
): Pick<Store, "sessionBurnSnapshot" | "hourTokenTotal" | "hasAudit"> => {
  const { pool } = ctx;
  return {
    /** A session's total model-request tokens and tool-call count — the
     * zero-tool-burn alert's two facts, one round trip. */
    async sessionBurnSnapshot(sessionId) {
      const { rows } = await pool.query(
        `SELECT
           (SELECT COALESCE(SUM(
              (payload->'usage'->>'input_tokens')::bigint
              + (payload->'usage'->>'output_tokens')::bigint
              + COALESCE((payload->'usage'->>'cache_read_tokens')::bigint, 0)
              + COALESCE((payload->'usage'->>'cache_write_tokens')::bigint, 0)
            ), 0) FROM events
             WHERE session_id = $1 AND kind = 'model_request') AS tokens,
           (SELECT COUNT(*) FROM events
             WHERE session_id = $1 AND kind = 'tool'
               AND payload->>'event' = 'call') AS tool_calls`,
        [sessionId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        totalTokens: Number(row.tokens),
        toolCalls: Number(row.tool_calls),
      };
    },

    /** One user's token burn in one UTC hour bucket, summed across models —
     * the same four kinds the model-grain rollups carry. */
    async hourTokenTotal(user, hour) {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(
           input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
         ), 0) AS tokens FROM model_hourly_rollup WHERE user_id = $1 AND hour = $2`,
        [user, hour],
      );
      return Number(rows[0]?.tokens ?? 0);
    },

    /** Whether the audit log already carries an entry for (action, target) —
     * the alerts' dedup: an append-only fact, so "fired before" never needs
     * its own state table. */
    async hasAudit(action, target) {
      const { rowCount } = await pool.query(
        "SELECT 1 FROM audit_log WHERE action = $1 AND target = $2 LIMIT 1",
        [action, target],
      );
      return (rowCount ?? 0) > 0;
    },
  };
};
