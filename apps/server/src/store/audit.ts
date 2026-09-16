import type { PgCtx } from "./db";
import { pgAuditRow } from "./rows";
import type { AuditEntry, Store } from "./types";

/**
 * ADR 0007: append one audit entry. The only write the audit log has —
 * shared by the store method and resolveOidcUser's provision entry.
 */
export const appendAudit = async (
  ctx: PgCtx,
  entry: AuditEntry,
): Promise<void> => {
  await ctx.pool.query(
    "INSERT INTO audit_log (actor_kind, actor_user, action, target, detail) VALUES ($1, $2, $3, $4, $5)",
    [
      entry.actor.kind,
      entry.actor.kind === "user" ? entry.actor.user : null,
      entry.action,
      entry.target,
      JSON.stringify(entry.detail ?? {}),
    ],
  );
};

export const auditMethods = (
  ctx: PgCtx,
): Pick<Store, "appendAudit" | "listAudit"> => ({
  async appendAudit(entry) {
    return appendAudit(ctx, entry);
  },

  async listAudit({ limit, offset, kind, actor }) {
    const filters: string[] = [];
    const params: unknown[] = [];
    // LIKE wildcards in user-supplied filters are matched literally —
    // an unescaped % or _ would widen the filter unexpectedly.
    const escapeLike = (v: string): string => v.replace(/[\\%_]/g, "\\$&");
    if (kind !== undefined) {
      params.push(`${escapeLike(kind)}.%`);
      filters.push(`action LIKE $${params.length}`);
    }
    if (actor !== undefined) {
      params.push(escapeLike(actor));
      const n = params.length;
      filters.push(
        `(actor_user ILIKE '%' || $${n} || '%' OR actor_kind = $${n})`,
      );
    }
    const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
    const { rows: counted } = await ctx.pool.query(
      `SELECT COUNT(*) AS n FROM audit_log${where}`,
      params,
    );
    const { rows } = await ctx.pool.query(
      `SELECT seq, occurred_at, actor_kind, actor_user, action, target, detail
         FROM audit_log${where} ORDER BY seq DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return {
      rows: rows.map((r) => pgAuditRow(r)),
      total: Number(counted[0]!.n),
    };
  },
});
