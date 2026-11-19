import { useRef, useState } from "react";
import { createApi, type SessionCommitRow } from "../api";
import { errorMessage } from "../lib/format";
import type { FeedStatus } from "./useSessions";
import { usePolledResource } from "./usePolled";

export type CommitsState = {
  commits: SessionCommitRow[];
  status: FeedStatus;
  lastError: string | null;
};

/**
 * v3 decision 34 data for one session: the git commits its tool calls made.
 * Polls slowly — rows land at call time and enrich when the result's raw
 * carries git's output — so the panel catches up within one interval without
 * burdening the 5s feed.
 */
export const useCommits = (
  sessionId: string | null,
  intervalMs = 30_000,
): CommitsState => {
  const api = useRef(createApi()).current;
  const [commits, setCommits] = useState<SessionCommitRow[]>([]);
  const [status, setStatus] = useState<FeedStatus>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  usePolledResource({
    createFetch: () => async () => ({
      commits: sessionId === null ? [] : await api.listCommits(sessionId),
    }),
    onSuccess: (page) => {
      setCommits(page.commits);
      setStatus("live");
      setLastError(null);
    },
    onError: (error) => {
      setStatus("down");
      setLastError(errorMessage(error));
    },
    reset: () => setCommits([]),
    deps: [sessionId],
    intervalMs,
    enabled: sessionId !== null,
  });
  return { commits, status, lastError };
};
