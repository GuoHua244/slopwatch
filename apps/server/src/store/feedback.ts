import type { PgCtx } from "./db";
import { pgFeedbackRow } from "./rows";
import type { Store } from "./types";

/**
 * Column list with the attachment metadata folded in as a json array —
 * every read carries the metas, the bytes never do. `ref` qualifies the
 * columns ("f." when selecting FROM feedback f; "" in a RETURNING clause,
 * where the bare name resolves to the inserted row).
 */
const FEEDBACK_COLUMNS = (ref: string) =>
  `${ref}feedback_id, ${ref}filer_id, ${ref}session_id, ${ref}kind, ${ref}body, ${ref}created_at,
   (SELECT COALESCE(json_agg(json_build_object('sha256', fa.sha256, 'filename', fa.filename, 'mime', fa.mime, 'size', fa.size) ORDER BY fa.created_at, fa.sha256), '[]'::json)
      FROM feedback_attachments fa WHERE fa.feedback_id = ${ref}feedback_id) AS attachments`;

export const feedbackMethods = (
  ctx: PgCtx,
): Pick<
  Store,
  | "addFeedback"
  | "getFeedback"
  | "listFeedback"
  | "deleteFeedback"
  | "addFeedbackAttachments"
  | "getFeedbackAttachment"
> => ({
  async addFeedback({ filerId, kind, body, sessionId }) {
    try {
      const { rows } = await ctx.pool.query(
        `INSERT INTO feedback (filer_id, kind, body, session_id) VALUES ($1, $2, $3, $4)
         RETURNING ${FEEDBACK_COLUMNS("")}`,
        [filerId, kind, body, sessionId],
      );
      return pgFeedbackRow(rows[0]!);
    } catch (e) {
      if ((e as { code?: string }).code === "23503") return null; // no such session
      throw e;
    }
  },

  async getFeedback(feedbackId) {
    const { rows } = await ctx.pool.query(
      `SELECT ${FEEDBACK_COLUMNS("f.")} FROM feedback f WHERE f.feedback_id = $1`,
      [feedbackId],
    );
    return rows[0] ? pgFeedbackRow(rows[0]) : null;
  },

  async listFeedback({ limit, offset, kind }) {
    const [rows, counted] = await Promise.all([
      kind
        ? ctx.pool.query(
            `SELECT ${FEEDBACK_COLUMNS("f.")} FROM feedback f WHERE f.kind = $3
             ORDER BY f.created_at DESC, f.feedback_id DESC
             LIMIT $1 OFFSET $2`,
            [limit, offset, kind],
          )
        : ctx.pool.query(
            `SELECT ${FEEDBACK_COLUMNS("f.")} FROM feedback f
             ORDER BY f.created_at DESC, f.feedback_id DESC
             LIMIT $1 OFFSET $2`,
            [limit, offset],
          ),
      kind
        ? ctx.pool.query(
            "SELECT count(*)::int AS total FROM feedback WHERE kind = $1",
            [kind],
          )
        : ctx.pool.query("SELECT count(*)::int AS total FROM feedback"),
    ]);
    return {
      rows: rows.rows.map(pgFeedbackRow),
      total: Number(counted.rows[0]!.total),
    };
  },

  async deleteFeedback(feedbackId) {
    const { rowCount } = await ctx.pool.query(
      "DELETE FROM feedback WHERE feedback_id = $1",
      [feedbackId],
    );
    return (rowCount ?? 0) > 0;
  },

  async addFeedbackAttachments(feedbackId, files) {
    if (files.length === 0) return;
    const values: string[] = [];
    const params: unknown[] = [feedbackId];
    for (const f of files) {
      const base = params.length;
      values.push(
        `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`,
      );
      params.push(f.sha256, f.filename, f.mime, f.size, f.data);
    }
    await ctx.pool.query(
      `INSERT INTO feedback_attachments (feedback_id, sha256, filename, mime, size, data)
       VALUES ${values.join(", ")}
       ON CONFLICT (feedback_id, sha256) DO NOTHING`,
      params,
    );
  },

  async getFeedbackAttachment(feedbackId, sha256) {
    const { rows } = await ctx.pool.query(
      "SELECT mime, filename, data FROM feedback_attachments WHERE feedback_id = $1 AND sha256 = $2",
      [feedbackId, sha256],
    );
    const row = rows[0];
    return row
      ? {
          mime: row.mime as string,
          filename: row.filename as string,
          data: row.data as Buffer,
        }
      : null;
  },
});
