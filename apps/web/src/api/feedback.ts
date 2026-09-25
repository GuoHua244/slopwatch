import { bearerAuth, defaultFetch, unwrapJson, type FetchLike } from "./http";
import type { FeedbackKind, FeedbackRow } from "./types";

export type FeedbackSubmission = {
  kind: FeedbackKind;
  text: string;
  /** Anchor the feedback to a session — the session-page entry point does. */
  sessionId?: string;
  files?: File[];
};

export type FeedbackApi = {
  /**
   * ADR 0009: file a feedback — a global note, or one anchored to a session.
   * Attachments are optional; the server re-validates every limit.
   */
  submit(submission: FeedbackSubmission): Promise<FeedbackRow>;
};

/**
 * Feedback-plane client (ADR 0009). Carries the filer's user token; the
 * intake is multipart because attachments ride the same request. The
 * content-type header is deliberately absent — the browser supplies the
 * multipart boundary.
 */
export const createFeedbackApi = (
  userToken: () => string | null,
  doFetch: FetchLike = defaultFetch,
): FeedbackApi => {
  const auth = bearerAuth(userToken);
  return {
    submit: async ({ kind, text, sessionId, files = [] }) => {
      const form = new FormData();
      form.set("kind", kind);
      form.set("text", text);
      for (const file of files) form.append("files", file, file.name);
      const path =
        sessionId === undefined
          ? "/feedback"
          : `/sessions/${encodeURIComponent(sessionId)}/feedback`;
      return (
        await unwrapJson<{ feedback: FeedbackRow }>(
          doFetch,
          path,
          auth({ method: "POST", body: form }),
          "POST",
        )
      ).feedback;
    },
  };
};
