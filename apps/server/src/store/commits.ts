import type { PgCtx } from "./db";
import { iso } from "./rows";
import type { Store } from "./types";

export const commitMethods = (
  ctx: PgCtx,
): Pick<Store, "listSessionCommits"> => {
  const { pool } = ctx;
  return {
    /** v3 decision 34: the commits one session's tool calls made, oldest
     * first — the SessionDetail panel's rows. */
    async listSessionCommits(sessionId) {
      const { rows } = await pool.query(
        `SELECT session_id, tool_call_id, subject, branch, sha, occurred_at
         FROM session_commits WHERE session_id = $1
         ORDER BY occurred_at ASC, tool_call_id ASC`,
        [sessionId],
      );
      return rows.map((r) => ({
        session_id: r.session_id as string,
        tool_call_id: r.tool_call_id as string,
        subject: (r.subject as string | null) ?? null,
        branch: (r.branch as string | null) ?? null,
        sha: (r.sha as string | null) ?? null,
        occurred_at: iso(r.occurred_at),
      }));
    },
  };
};
