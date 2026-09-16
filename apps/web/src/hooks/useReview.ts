import { useEffect, useRef, useState } from "react";
import {
  createReviewApi,
  type CommentRow,
  type MeInfo,
  type ReviewApi,
  type ReviewRow,
} from "../api";
import { storedToken } from "../auth";
import { errorMessage } from "../lib/format";
import type { FeedStatus } from "./useSessions";
import { usePolledResource } from "./usePolled";

export type ReviewState = {
  api: ReviewApi;
  me: MeInfo | null;
  review: ReviewRow | null;
  comments: CommentRow[];
  status: FeedStatus;
  lastError: string | null;
  /** Force an immediate re-poll after a mutation. */
  refresh: () => void;
};

/** What one polling tick fetches: the marker and the notes together. */
type ReviewPage = { review: ReviewRow | null; comments: CommentRow[] };

/**
 * Decision 10 data for one session: the review marker and the review notes,
 * polled on the decision-4 contract; review changes made elsewhere surface
 * within one interval.
 */
export const useReview = (
  sessionId: string | null,
  intervalMs = 5000,
): ReviewState => {
  const api = useRef(createReviewApi(storedToken)).current;
  const [me, setMe] = useState<MeInfo | null>(null);
  const [review, setReview] = useState<ReviewRow | null>(null);
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [status, setStatus] = useState<FeedStatus>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  // Identify once per token change; /me is cheap enough to retry with the poll.
  useEffect(() => {
    let active = true;
    const who = async (): Promise<void> => {
      if (!storedToken()) {
        setMe(null);
        return;
      }
      try {
        const info = await api.me();
        if (active) setMe(info);
      } catch {
        if (active) setMe(null);
      }
    };
    void who();
    return () => {
      active = false;
    };
  }, [api, version]);

  usePolledResource<ReviewPage>({
    deps: [sessionId, intervalMs, api, version],
    intervalMs,
    enabled: sessionId !== null,
    // New generation: no marker or notes from the previous session may linger.
    reset: () => {
      setReview(null);
      setComments([]);
      setStatus("connecting");
    },
    createFetch: () => async () => {
      const [review, comments] = await Promise.all([
        api.review(sessionId!),
        api.comments(sessionId!),
      ]);
      return { review, comments };
    },
    onSuccess: (page) => {
      setReview(page.review);
      setComments(page.comments);
      setStatus("live");
      setLastError(null);
    },
    onError: (error) => {
      setStatus("down");
      setLastError(errorMessage(error));
    },
  });

  return {
    api,
    me,
    review,
    comments,
    status,
    lastError,
    refresh: () => setVersion((v) => v + 1),
  };
};
