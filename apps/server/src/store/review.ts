import type { PgCtx } from "./db";
import { pgCommentRow, pgReviewRow } from "./rows";
import type { Store } from "./types";

export const reviewMethods = (
  ctx: PgCtx,
): Pick<
  Store,
  | "markReviewed"
  | "unmarkReviewed"
  | "reviewFor"
  | "addComment"
  | "listComments"
  | "deleteComment"
  | "getComment"
> => ({
  async markReviewed(sessionId, reviewerId) {
    try {
      const { rows } = await ctx.pool.query(
        `INSERT INTO session_reviews (session_id, reviewer_id) VALUES ($1, $2)
         ON CONFLICT (session_id) DO UPDATE
           SET reviewer_id = EXCLUDED.reviewer_id, reviewed_at = now()
         RETURNING session_id, reviewer_id, reviewed_at`,
        [sessionId, reviewerId],
      );
      return pgReviewRow(rows[0]!);
    } catch (e) {
      if ((e as { code?: string }).code === "23503") return null; // no such session
      throw e;
    }
  },

  async unmarkReviewed(sessionId) {
    const { rowCount } = await ctx.pool.query(
      "DELETE FROM session_reviews WHERE session_id = $1",
      [sessionId],
    );
    return (rowCount ?? 0) > 0;
  },

  async reviewFor(sessionId) {
    const { rows } = await ctx.pool.query(
      "SELECT session_id, reviewer_id, reviewed_at FROM session_reviews WHERE session_id = $1",
      [sessionId],
    );
    return rows[0] ? pgReviewRow(rows[0]) : null;
  },

  async addComment(sessionId, turnId, authorId, body) {
    try {
      const { rows } = await ctx.pool.query(
        "INSERT INTO review_comments (session_id, turn_id, author_id, body) VALUES ($1, $2, $3, $4) RETURNING comment_id, session_id, turn_id, author_id, body, created_at",
        [sessionId, turnId, authorId, body],
      );
      return pgCommentRow(rows[0]!);
    } catch (e) {
      if ((e as { code?: string }).code === "23503") return null; // no such session
      throw e;
    }
  },

  async listComments(sessionId) {
    const { rows } = await ctx.pool.query(
      "SELECT comment_id, session_id, turn_id, author_id, body, created_at FROM review_comments WHERE session_id = $1 ORDER BY created_at ASC, comment_id ASC",
      [sessionId],
    );
    return rows.map((r) => pgCommentRow(r));
  },

  async deleteComment(commentId, authorId) {
    const { rowCount } = await ctx.pool.query(
      "DELETE FROM review_comments WHERE comment_id = $1 AND author_id = $2",
      [commentId, authorId],
    );
    return rowCount === 1;
  },

  async getComment(commentId) {
    const { rows } = await ctx.pool.query(
      "SELECT comment_id, session_id, turn_id, author_id, body, created_at FROM review_comments WHERE comment_id = $1",
      [commentId],
    );
    return rows[0] ? pgCommentRow(rows[0]) : null;
  },
});
