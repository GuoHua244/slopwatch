import type { PgCtx } from "./db";
import { iso } from "./rows";
import type { Store } from "./types";

export const quarantineMethods = (
  ctx: PgCtx,
): Pick<Store, "health" | "listQuarantine"> => ({
  /** Health spans sessions, events, and quarantine, so it sits here — the
   * smallest read plane that already touches all three tables' homes. */
  async health() {
    const { rows } = await ctx.pool.query(
      `SELECT (SELECT COUNT(*) FROM sessions) AS sessions,
              (SELECT COUNT(*) FROM events) AS events,
              (SELECT MAX(received_at) FROM events) AS last_event_at,
              (SELECT COUNT(*) FROM quarantine) AS quarantine_total,
              (SELECT COUNT(*) FROM quarantine WHERE created_at > now() - interval '24 hours') AS quarantine_24h,
              (SELECT MAX(created_at) FROM quarantine) AS last_quarantine_at`,
    );
    return {
      sessions: Number(rows[0]!.sessions),
      events: Number(rows[0]!.events),
      last_event_at: rows[0]!.last_event_at
        ? iso(rows[0]!.last_event_at)
        : null,
      quarantine_total: Number(rows[0]!.quarantine_total),
      quarantine_24h: Number(rows[0]!.quarantine_24h),
      last_quarantine_at: rows[0]!.last_quarantine_at
        ? iso(rows[0]!.last_quarantine_at)
        : null,
    };
  },

  async listQuarantine(limit) {
    const { rows } = await ctx.pool.query(
      "SELECT seq, agent, session_id, reason, line, occurred_at, created_at FROM quarantine ORDER BY seq DESC LIMIT $1",
      [limit],
    );
    return rows.map((r) => ({
      seq: Number(r.seq),
      agent: r.agent as string,
      session_id: r.session_id as string,
      reason: r.reason as string,
      line: r.line as string,
      occurred_at: iso(r.occurred_at),
      created_at: iso(r.created_at),
    }));
  },
});
