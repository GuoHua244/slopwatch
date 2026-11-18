import {
  authedClient,
  defaultFetch,
  getJson,
  unwrapJson,
  type FetchLike,
} from "./http";
import type { CommentRow, MeInfo, ReviewRow } from "./types";

export type ReviewApi = {
  me(): Promise<MeInfo>;
  /**
   * ADR 0011: set the caller's password (first time) or change it (the
   * server requires current_password when one already exists). Other
   * sign-in sessions are revoked server-side.
   */
  setPassword(body: {
    new_password: string;
    current_password?: string;
  }): Promise<void>;
  /** Org-wide read: the session's review marker, or null when unreviewed. */
  review(sessionId: string): Promise<ReviewRow | null>;
  /** DRI-only server-side; 403 surfaces as ApiError for non-DRIs. */
  markReviewed(sessionId: string): Promise<ReviewRow>;
  unmarkReviewed(sessionId: string): Promise<void>;
  comments(sessionId: string): Promise<CommentRow[]>;
  addComment(
    sessionId: string,
    turnId: string | null,
    body: string,
  ): Promise<CommentRow>;
  /** Author-only server-side; 404 for someone else's note or an unknown id. */
  deleteComment(sessionId: string, commentId: number): Promise<void>;
};

/**
 * Review-plane client (decision 10). Reads and writes both carry the
 * reader's user token (v2 decision 22); the review marker additionally
 * requires the DRI role, enforced server-side.
 */
export const createReviewApi = (
  userToken: () => string | null,
  doFetch: FetchLike = defaultFetch,
): ReviewApi => {
  const { auth, authedJson } = authedClient(userToken);
  return {
    me: async () =>
      unwrapJson<MeInfo>(doFetch, "/me", auth({ method: "GET" }), "GET"),
    setPassword: async (body) => {
      await unwrapJson(doFetch, "/me/password", authedJson("PUT", body), "PUT");
    },
    review: async (sessionId) =>
      (
        await getJson<{ review: ReviewRow | null }>(
          doFetch,
          `/sessions/${encodeURIComponent(sessionId)}/review`,
          auth(),
        )
      ).review,
    markReviewed: async (sessionId) =>
      (
        await unwrapJson<{ review: ReviewRow }>(
          doFetch,
          `/sessions/${encodeURIComponent(sessionId)}/review`,
          auth({ method: "POST" }),
          "POST",
        )
      ).review,
    unmarkReviewed: async (sessionId) => {
      await unwrapJson(
        doFetch,
        `/sessions/${encodeURIComponent(sessionId)}/review`,
        auth({ method: "DELETE" }),
        "DELETE",
      );
    },
    comments: async (sessionId) =>
      (
        await getJson<{ comments: CommentRow[] }>(
          doFetch,
          `/sessions/${encodeURIComponent(sessionId)}/comments`,
          auth(),
        )
      ).comments,
    addComment: async (sessionId, turnId, body) =>
      (
        await unwrapJson<{ comment: CommentRow }>(
          doFetch,
          `/sessions/${encodeURIComponent(sessionId)}/comments`,
          authedJson("POST", { turn_id: turnId, body }),
          "POST",
        )
      ).comment,
    deleteComment: async (sessionId, commentId) => {
      await unwrapJson(
        doFetch,
        `/sessions/${encodeURIComponent(sessionId)}/comments/${commentId}`,
        auth({ method: "DELETE" }),
        "DELETE",
      );
    },
  };
};
