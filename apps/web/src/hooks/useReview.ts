import { useEffect, useRef, useState } from "react";
import {
  createReviewApi,
  type CommentRow,
  type MeInfo,
  type ReviewApi,
  type ReviewRow,
} from "../api";
import { createPoller } from "../lib/poller";
import { storedToken } from "../auth";
import type { FeedStatus } from "./useSessions";

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
  const mounted = useRef(true);

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

  useEffect(() => {
    mounted.current = true;
    setReview(null);
    setComments([]);
    setStatus("connecting");
    if (!sessionId) return () => {};
    const poller = createPoller({
      intervalMs,
      tick: async () => {
        const [r, cs] = await Promise.all([
          api.review(sessionId),
          api.comments(sessionId),
        ]);
        if (!mounted.current) return;
        setReview(r);
        setComments(cs);
        setStatus("live");
        setLastError(null);
      },
      onError: (error) => {
        if (!mounted.current) return;
        setStatus("down");
        setLastError(error instanceof Error ? error.message : String(error));
      },
    });
    poller.start();
    return () => {
      mounted.current = false;
      poller.stop();
    };
  }, [sessionId, intervalMs, api, version]);

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
