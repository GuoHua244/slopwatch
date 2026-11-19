import { withTransaction, type PgCtx, type Queryable } from "./db";
import { modelRollupRow } from "./rows";
import type { RollupsSnapshot, Store } from "./types";

const DAY_BUCKET_SQL = `to_char((e.payload->>'occurred_at')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
const HOUR_BUCKET_SQL = `to_char((e.payload->>'occurred_at')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24')`;

/** The SUM list every all-time model-grain aggregate shares. */
export const MODEL_SUMS =
  "SUM(model_requests) AS model_requests, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens";

/**
 * Rebuild the rollup tables from the events table — the aggregate truth —
 * either for one user (after a session delete) or for everyone (backfill).
 * Bucketing mirrors rollups.ts: UTC day/hour of the event's occurred_at.
 */
export const recomputeRollups = async (
  client: Queryable,
  userId?: string,
): Promise<number> => {
  const scoped = userId !== undefined;
  const args = scoped ? [userId] : [];
  const filter = scoped ? " AND s.user_id = $1" : "";
  for (const table of [
    "user_daily_rollup",
    "user_hourly_rollup",
    "model_daily_rollup",
    "model_hourly_rollup",
  ]) {
    await client.query(
      `DELETE FROM ${table}${scoped ? " WHERE user_id = $1" : ""}`,
      args,
    );
  }
  const from = `
    FROM events e
    JOIN sessions s ON s.session_id = e.session_id
    WHERE s.user_id IS NOT NULL${filter}`;
  // ON CONFLICT DO UPDATE (absolute overwrite — these rows are recomputed
  // truth): a concurrent ingest's rollup upsert for the same key would
  // otherwise raise 23505 under READ COMMITTED and fail the whole recompute.
  // The waste counters (v3 decision 31) rebuild here with the same semantics
  // the ingest path counts incrementally: a failed result is a filter over
  // result events; a repeated call is a call whose (session, tool, args)
  // rank — ordered by occurred_at then seq, the ingest order — is beyond 1,
  // attributed to the repeat's own bucket. The `event` key joins the
  // partition so a call and its result never share a rank sequence.
  const flatInsert = (table: string, bucketSql: string) => `
    INSERT INTO ${table} (user_id, ${
      table === "user_daily_rollup" ? "day" : "hour"
    }, turns, tool_calls, failed_tool_calls, repeated_calls)
    SELECT user_id, bucket,
           COUNT(*) FILTER (WHERE phase = 'turn' AND ev = 'start'),
           COUNT(*) FILTER (WHERE phase = 'tool' AND ev = 'call'),
           COUNT(*) FILTER (
             WHERE phase = 'tool' AND ev = 'result' AND ok = 'false'
           ),
           COALESCE(SUM(
             CASE WHEN phase = 'tool' AND ev = 'call' AND rn > 1
                  THEN 1 ELSE 0 END
           ), 0)
    FROM (
      SELECT s.user_id,
             ${bucketSql} AS bucket,
             e.kind AS phase,
             e.payload->>'event' AS ev,
             e.payload->>'ok' AS ok,
             ROW_NUMBER() OVER (
               PARTITION BY e.session_id, e.payload->>'tool',
                            e.payload->'args', e.payload->>'event'
               ORDER BY (e.payload->>'occurred_at')::timestamptz, e.event_seq
             ) AS rn
      ${from}
    ) w
    GROUP BY user_id, bucket
    HAVING COUNT(*) FILTER (WHERE phase = 'turn' AND ev = 'start') > 0
        OR COUNT(*) FILTER (WHERE phase = 'tool' AND ev = 'call') > 0
        OR COUNT(*) FILTER (
             WHERE phase = 'tool' AND ev = 'result' AND ok = 'false'
           ) > 0
        OR SUM(CASE WHEN phase = 'tool' AND ev = 'call' AND rn > 1
                    THEN 1 ELSE 0 END) > 0
    ON CONFLICT (user_id, ${
      table === "user_daily_rollup" ? "day" : "hour"
    }) DO UPDATE SET
      turns = EXCLUDED.turns, tool_calls = EXCLUDED.tool_calls,
      failed_tool_calls = EXCLUDED.failed_tool_calls,
      repeated_calls = EXCLUDED.repeated_calls`;
  const flat = await client.query(
    flatInsert("user_daily_rollup", DAY_BUCKET_SQL),
    args,
  );
  const flatHourly = await client.query(
    flatInsert("user_hourly_rollup", HOUR_BUCKET_SQL),
    args,
  );
  const modelInsert = (table: string, bucketSql: string) => `
    INSERT INTO ${table} (user_id, ${
      table === "model_daily_rollup" ? "day" : "hour"
    }, model, model_requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
    SELECT s.user_id,
           ${bucketSql},
           e.payload->>'model',
           COUNT(*),
           SUM(COALESCE((e.payload->'usage'->>'input_tokens')::bigint, 0)),
           SUM(COALESCE((e.payload->'usage'->>'output_tokens')::bigint, 0)),
           SUM(COALESCE((e.payload->'usage'->>'cache_read_tokens')::bigint, 0)),
           SUM(COALESCE((e.payload->'usage'->>'cache_write_tokens')::bigint, 0))
    ${from} AND e.kind = 'model_request'
    GROUP BY s.user_id, 2, 3
    ON CONFLICT (user_id, ${
      table === "model_daily_rollup" ? "day" : "hour"
    }, model) DO UPDATE SET
      model_requests = EXCLUDED.model_requests,
      input_tokens = EXCLUDED.input_tokens,
      output_tokens = EXCLUDED.output_tokens,
      cache_read_tokens = EXCLUDED.cache_read_tokens,
      cache_write_tokens = EXCLUDED.cache_write_tokens`;
  const daily = await client.query(
    modelInsert("model_daily_rollup", DAY_BUCKET_SQL),
    args,
  );
  const hourly = await client.query(
    modelInsert("model_hourly_rollup", HOUR_BUCKET_SQL),
    args,
  );
  return (
    (flat.rowCount ?? 0) +
    (flatHourly.rowCount ?? 0) +
    (daily.rowCount ?? 0) +
    (hourly.rowCount ?? 0)
  );
};

/**
 * Rebuild the per-session waste counters (v3 decision 31) from the events
 * table — the same facts the ingest path accumulates incrementally, so a
 * backfill or post-delete recompute can never leave a session row drifted
 * from its events. Sessions absent from both subqueries have no tool events
 * and never accumulated waste incrementally, so leaving them untouched is
 * leaving them correct.
 */
export const recomputeSessionWaste = async (
  client: Queryable,
  userId?: string,
): Promise<number> => {
  const scoped = userId !== undefined;
  const args = scoped ? [userId] : [];
  const filter = scoped ? " AND s.user_id = $1" : "";
  const { rowCount } = await client.query(
    `UPDATE sessions s
     SET failed_tool_calls = a.failed, repeated_calls = a.repeated
     FROM (
       SELECT COALESCE(f.session_id, r.session_id) AS session_id,
              COALESCE(f.failed, 0) AS failed,
              COALESCE(r.repeated, 0) AS repeated
       FROM (
         SELECT session_id, COUNT(*) AS failed
         FROM events
         WHERE kind = 'tool' AND payload->>'event' = 'result'
           AND (payload->>'ok') = 'false'
         GROUP BY session_id
       ) f
       FULL OUTER JOIN (
         SELECT session_id, COUNT(*) FILTER (WHERE rn > 1) AS repeated
         FROM (
           SELECT session_id,
                  ROW_NUMBER() OVER (
                    PARTITION BY session_id, payload->>'tool',
                                 payload->'args', payload->>'event'
                    ORDER BY (payload->>'occurred_at')::timestamptz, event_seq
                  ) AS rn
           FROM events
           WHERE kind = 'tool' AND payload->>'event' = 'call'
         ) x
         GROUP BY session_id
       ) r ON f.session_id = r.session_id
     ) a
     WHERE s.session_id = a.session_id${filter}`,
    args,
  );
  return rowCount ?? 0;
};

export const rollupMethods = (
  ctx: PgCtx,
): Pick<Store, "listRollups" | "backfillRollups"> => {
  const { pool } = ctx;
  return {
    async listRollups(sinceDay, sinceHour, teamId, userId) {
      // Team scope (v2 decision 27): rollups are user-grain, so membership
      // resolves through users.team_id — never sessions' creation-time snapshot.
      // The self scope carries the caller's own user_id straight in. `WHERE
      // TRUE` gives every query an anchor for the AND.
      const scope = (
        baseParams: unknown[],
      ): { sql: string; params: unknown[] } => {
        const sql: string[] = [];
        const params = [...baseParams];
        if (teamId === "unassigned")
          sql.push(
            "user_id NOT IN (SELECT name FROM users WHERE team_id IS NOT NULL)",
          );
        else if (teamId !== undefined) {
          params.push(teamId);
          sql.push(
            `user_id IN (SELECT name FROM users WHERE team_id = $${params.length})`,
          );
        }
        if (userId !== undefined) {
          params.push(userId);
          sql.push(`user_id = $${params.length}`);
        }
        return {
          sql: sql.length > 0 ? ` AND ${sql.join(" AND ")}` : "",
          params,
        };
      };
      // The windowed aggregates share one shape per row family — table,
      // bucket column, inclusive lower bound — so daily/hourly is a call
      // apart, never a string-replace.
      const flatWindow = (
        table: "user_daily_rollup" | "user_hourly_rollup",
        column: "day" | "hour",
        since: string,
      ) => {
        const s = scope([since]);
        return pool.query(
          `SELECT user_id, ${column}, turns, tool_calls, failed_tool_calls, repeated_calls FROM ${table} WHERE ${column} >= $1${s.sql} ORDER BY user_id, ${column}`,
          s.params,
        );
      };
      const modelWindow = (
        table: "model_daily_rollup" | "model_hourly_rollup",
        column: "day" | "hour",
        since: string,
      ) => {
        const s = scope([since]);
        return pool.query(
          `SELECT user_id, ${column} AS bucket, model, model_requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM ${table} WHERE ${column} >= $1${s.sql} ORDER BY user_id, ${column}, model`,
          s.params,
        );
      };
      const totalsScope = scope([]);
      const totals = await pool.query(
        `SELECT user_id, SUM(turns) AS turns, SUM(tool_calls) AS tool_calls, SUM(failed_tool_calls) AS failed_tool_calls, SUM(repeated_calls) AS repeated_calls FROM user_daily_rollup WHERE TRUE${totalsScope.sql} GROUP BY user_id ORDER BY user_id`,
        totalsScope.params,
      );
      const modelTotalsScope = scope([]);
      const modelTotals = await pool.query(
        `SELECT user_id, model, ${MODEL_SUMS} FROM model_daily_rollup WHERE TRUE${modelTotalsScope.sql} GROUP BY user_id, model ORDER BY user_id, model`,
        modelTotalsScope.params,
      );
      const daily = await flatWindow("user_daily_rollup", "day", sinceDay);
      const userHourly = await flatWindow(
        "user_hourly_rollup",
        "hour",
        sinceHour,
      );
      const modelDaily = await modelWindow(
        "model_daily_rollup",
        "day",
        sinceDay,
      );
      const modelHourly = await modelWindow(
        "model_hourly_rollup",
        "hour",
        sinceHour,
      );
      return {
        totals: totals.rows.map((r) => ({
          user_id: r.user_id as string,
          turns: Number(r.turns),
          tool_calls: Number(r.tool_calls),
          failed_tool_calls: Number(r.failed_tool_calls),
          repeated_calls: Number(r.repeated_calls),
        })),
        model_totals: modelTotals.rows.map((r) =>
          modelRollupRow({ ...r, bucket: "" }),
        ),
        daily: daily.rows.map((r) => ({
          user_id: r.user_id as string,
          day: r.day as string,
          turns: Number(r.turns),
          tool_calls: Number(r.tool_calls),
          failed_tool_calls: Number(r.failed_tool_calls),
          repeated_calls: Number(r.repeated_calls),
        })),
        model_daily: modelDaily.rows.map(modelRollupRow),
        model_hourly: modelHourly.rows.map(modelRollupRow),
        user_hourly: userHourly.rows.map((r) => ({
          user_id: r.user_id as string,
          hour: r.hour as string,
          turns: Number(r.turns),
          tool_calls: Number(r.tool_calls),
          failed_tool_calls: Number(r.failed_tool_calls),
          repeated_calls: Number(r.repeated_calls),
        })),
      };
    },

    async backfillRollups() {
      return withTransaction(pool, async (client) => {
        const rows = await recomputeRollups(client);
        await recomputeSessionWaste(client);
        return rows;
      });
    },
  };
};
