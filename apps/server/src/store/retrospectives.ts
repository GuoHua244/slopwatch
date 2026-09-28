import type { NormalEvent } from "@slopwatch/events";
import type { PgCtx } from "./db";
import { iso } from "./rows";
import type {
  ChildSessionRollup,
  LlmConfig,
  RetroRow,
  StoredEvent,
  Store,
} from "./types";

const RETRO_COLUMNS =
  "id, session_id, user_id, angle, supplement, system_snapshot, prompt_snapshot, status, phase, output_chars, output_tail, heartbeat_at, result, model, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, error, created_at, started_at, finished_at";

/** List responses drop the two snapshot columns — they are prompt-sized. */
const RETRO_LIST_COLUMNS =
  "id, session_id, user_id, angle, supplement, status, phase, output_chars, output_tail, heartbeat_at, result, model, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, error, created_at, started_at, finished_at";

const pgRetroRow = (r: Record<string, unknown>): RetroRow => ({
  id: Number(r.id),
  session_id: r.session_id as string,
  user_id: r.user_id as string,
  angle: r.angle as string,
  supplement: (r.supplement as string | null) ?? null,
  system_snapshot: (r.system_snapshot as string | null) ?? "",
  prompt_snapshot: (r.prompt_snapshot as string | null) ?? "",
  status: ((): RetroRow["status"] => {
    const s = r.status;
    return s === "running" || s === "completed" || s === "failed"
      ? s
      : "pending";
  })(),
  phase: ((): RetroRow["phase"] => {
    const p = r.phase;
    return p === "waiting_first_byte" || p === "streaming" ? p : null;
  })(),
  output_chars:
    r.output_chars === null || r.output_chars === undefined
      ? null
      : Number(r.output_chars),
  output_tail: (r.output_tail as string | null) ?? null,
  heartbeat_at: r.heartbeat_at ? iso(r.heartbeat_at) : null,
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
  started_at: r.started_at ? iso(r.started_at) : null,
  finished_at: r.finished_at ? iso(r.finished_at) : null,
});

export const retrospectiveMethods = (
  ctx: PgCtx,
): Pick<
  Store,
  | "createRetro"
  | "getRetro"
  | "listRetros"
  | "setRetroRunning"
  | "setRetroProgress"
  | "setRetroCompleted"
  | "setRetroFailed"
  | "failStaleRetros"
  | "hasOpenRetroFor"
  | "allEvents"
  | "rawForEvents"
  | "childRollups"
  | "getLlmConfig"
  | "setLlmConfig"
  | "clearLlmConfig"
> => {
  const { pool } = ctx;
  return {
    async createRetro(row) {
      const { rows } = await pool.query(
        `INSERT INTO retrospectives
           (session_id, user_id, angle, supplement, system_snapshot, prompt_snapshot, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')
         RETURNING ${RETRO_COLUMNS}`,
        [
          row.sessionId,
          row.userId,
          row.angle,
          row.supplement,
          row.systemSnapshot,
          row.promptSnapshot,
        ],
      );
      return pgRetroRow(rows[0]!);
    },

    async getRetro(id) {
      const { rows } = await pool.query(
        `SELECT ${RETRO_COLUMNS} FROM retrospectives WHERE id = $1`,
        [id],
      );
      return rows[0] ? pgRetroRow(rows[0]) : null;
    },

    async listRetros(sessionId) {
      const { rows } = await pool.query(
        `SELECT ${RETRO_LIST_COLUMNS} FROM retrospectives
         WHERE session_id = $1 ORDER BY id DESC`,
        [sessionId],
      );
      return rows.map((r) =>
        pgRetroRow({ ...r, system_snapshot: "", prompt_snapshot: "" }),
      );
    },

    async setRetroRunning(id) {
      await pool.query(
        "UPDATE retrospectives SET status = 'running', started_at = now() WHERE id = $1",
        [id],
      );
    },

    async setRetroProgress(id, phase, outputChars, tail) {
      // The status guard makes progress writes idempotent against a run
      // that finished while a throttled callback was still in flight —
      // a late write can never resurrect a terminal row's progress line.
      await pool.query(
        `UPDATE retrospectives SET phase = $2, output_chars = $3, output_tail = $4, heartbeat_at = now()
         WHERE id = $1 AND status = 'running'`,
        [id, phase, outputChars, tail],
      );
    },

    async setRetroCompleted(id, patch) {
      const u = patch.usage ?? {};
      await pool.query(
        `UPDATE retrospectives SET status = 'completed', result = $2, model = $3,
           input_tokens = $4, output_tokens = $5, cache_read_tokens = $6, reasoning_tokens = $7,
           phase = NULL, output_chars = NULL, output_tail = NULL, heartbeat_at = NULL,
           finished_at = now()
         WHERE id = $1`,
        [
          id,
          patch.result,
          patch.model,
          u.inputTokens ?? null,
          u.outputTokens ?? null,
          u.cacheReadTokens ?? null,
          u.reasoningTokens ?? null,
        ],
      );
    },

    async setRetroFailed(id, error) {
      await pool.query(
        `UPDATE retrospectives SET status = 'failed', error = $2,
           phase = NULL, output_chars = NULL, output_tail = NULL, heartbeat_at = NULL,
           finished_at = now()
         WHERE id = $1`,
        [id, error.slice(0, 2000)],
      );
    },

    async failStaleRetros() {
      const { rowCount } = await pool.query(
        `UPDATE retrospectives SET status = 'failed',
           error = 'the server restarted before this run finished',
           phase = NULL, output_chars = NULL, output_tail = NULL, heartbeat_at = NULL,
           finished_at = now()
         WHERE status IN ('pending', 'running')`,
      );
      return rowCount ?? 0;
    },

    async hasOpenRetroFor(userId) {
      const { rowCount } = await pool.query(
        "SELECT 1 FROM retrospectives WHERE user_id = $1 AND status IN ('pending', 'running') LIMIT 1",
        [userId],
      );
      return (rowCount ?? 0) > 0;
    },

    async allEvents(sessionId) {
      const { rows } = await pool.query(
        "SELECT event_seq, payload FROM events WHERE session_id = $1 ORDER BY event_seq ASC",
        [sessionId],
      );
      return rows.map((r) => ({
        event_seq: Number(r.event_seq),
        event: r.payload as NormalEvent,
      }));
    },

    async rawForEvents(sessionId, seqs) {
      if (seqs.length === 0) return [];
      const { rows } = await pool.query(
        "SELECT event_seq, raw FROM events WHERE session_id = $1 AND event_seq = ANY($2::bigint[]) AND raw IS NOT NULL",
        [sessionId, seqs.map((n) => n.toString())],
      );
      return rows.map((r) => ({
        event_seq: Number(r.event_seq),
        raw: r.raw,
      }));
    },

    async childRollups(sessionId) {
      // Children declare themselves in their session:start payload; the
      // partial expression index makes this a targeted probe.
      const childIds = await pool.query(
        `SELECT DISTINCT session_id FROM events
         WHERE payload->>'parent_session_id' = $1`,
        [sessionId],
      );
      const ids = childIds.rows.map((r) => r.session_id as string);
      if (ids.length === 0) return [];
      const sessionRows = await pool.query(
        `SELECT session_id, agent, title, task_preview,
                total_input_tokens, total_output_tokens,
                total_cache_read_tokens, total_cache_write_tokens
         FROM sessions WHERE session_id = ANY($1::text[])`,
        [ids],
      );
      const stats = await pool.query(
        `SELECT session_id,
           COUNT(*) FILTER (WHERE kind = 'turn' AND payload->>'event' = 'start') AS turns,
           COUNT(*) FILTER (WHERE kind = 'model_request') AS model_requests,
           COUNT(*) FILTER (WHERE kind = 'tool' AND payload->>'event' = 'call') AS tool_calls,
           COUNT(*) FILTER (WHERE kind = 'tool' AND payload->>'event' = 'result'
                            AND (payload->>'ok') = 'false') AS tool_errors
         FROM events WHERE session_id = ANY($1::text[])
         GROUP BY session_id`,
        [ids],
      );
      const tools = await pool.query(
        `SELECT session_id, payload->>'tool' AS tool, COUNT(*) AS calls
         FROM events
         WHERE session_id = ANY($1::text[]) AND kind = 'tool' AND payload->>'event' = 'call'
         GROUP BY session_id, payload->>'tool' ORDER BY calls DESC`,
        [ids],
      );
      const firstMessages = await pool.query(
        `SELECT DISTINCT ON (session_id) session_id, payload->>'user_message' AS msg
         FROM events
         WHERE session_id = ANY($1::text[]) AND kind = 'turn' AND payload->>'event' = 'start'
           AND payload->>'user_message' IS NOT NULL
         ORDER BY session_id, event_seq`,
        [ids],
      );
      const nested = await pool.query(
        `SELECT payload->>'parent_session_id' AS parent, COUNT(DISTINCT session_id) AS n
         FROM events
         WHERE payload->>'parent_session_id' = ANY($1::text[])
         GROUP BY payload->>'parent_session_id'`,
        [ids],
      );
      const statsById = new Map(
        stats.rows.map((r) => [r.session_id as string, r]),
      );
      const toolsById = new Map<string, { tool: string; calls: number }[]>();
      for (const r of tools.rows) {
        const sid = r.session_id as string;
        const list = toolsById.get(sid) ?? [];
        list.push({ tool: r.tool as string, calls: Number(r.calls) });
        toolsById.set(sid, list);
      }
      const msgById = new Map(
        firstMessages.rows.map((r) => [
          r.session_id as string,
          r.msg as string,
        ]),
      );
      const nestedById = new Map(
        nested.rows.map((r) => [r.parent as string, Number(r.n)]),
      );
      return sessionRows.rows
        .map((s): ChildSessionRollup => {
          const sid = s.session_id as string;
          const st = statsById.get(sid);
          return {
            session_id: sid,
            agent: s.agent as string,
            title: (s.title as string | null) ?? null,
            task_preview: (s.task_preview as string | null) ?? null,
            input_tokens: Number(s.total_input_tokens ?? 0),
            output_tokens: Number(s.total_output_tokens ?? 0),
            cache_read_tokens: Number(s.total_cache_read_tokens ?? 0),
            cache_write_tokens: Number(s.total_cache_write_tokens ?? 0),
            turns: Number(st?.turns ?? 0),
            model_requests: Number(st?.model_requests ?? 0),
            tool_calls: Number(st?.tool_calls ?? 0),
            tool_errors: Number(st?.tool_errors ?? 0),
            tools: toolsById.get(sid) ?? [],
            first_user_message: msgById.get(sid) ?? null,
            sub_sessions: nestedById.get(sid) ?? 0,
          };
        })
        .sort((a, b) => a.session_id.localeCompare(b.session_id));
    },

    async getLlmConfig(name) {
      const { rows } = await pool.query(
        "SELECT llm_endpoint, llm_model, llm_api_key FROM users WHERE name = $1",
        [name],
      );
      const row = rows[0];
      if (!row?.llm_endpoint || !row?.llm_model || !row?.llm_api_key)
        return null;
      return {
        endpoint: row.llm_endpoint as string,
        model: row.llm_model as string,
        apiKey: row.llm_api_key as string,
      };
    },

    async setLlmConfig(name, config) {
      await pool.query(
        "UPDATE users SET llm_endpoint = $2, llm_model = $3, llm_api_key = $4 WHERE name = $1",
        [name, config.endpoint, config.model, config.apiKey],
      );
    },

    async clearLlmConfig(name) {
      await pool.query(
        "UPDATE users SET llm_endpoint = NULL, llm_model = NULL, llm_api_key = NULL WHERE name = $1",
        [name],
      );
    },
  };
};
