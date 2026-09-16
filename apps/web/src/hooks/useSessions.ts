import { useState } from "react";
import { createApi, type SessionSummary } from "../api";
import { errorMessage } from "../lib/format";
import { usePolledResource } from "./usePolled";

export type FeedStatus = "connecting" | "live" | "down";

export type SessionFeed = {
  sessions: SessionSummary[];
  status: FeedStatus;
  lastError: string | null;
  lastUpdated: Date | null;
};

const api = createApi();

/** Decision 4: poll GET /sessions every ~5s and on tab focus. A non-null
 * teamId narrows the poll to one team (or the "unassigned" bucket). When
 * `enabled` is false (pre-auth) nothing polls and the feed stays empty —
 * no anonymous 401 noise. */
export const useSessions = (
  teamId: string | null = null,
  intervalMs = 5000,
  enabled = true,
): SessionFeed => {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [status, setStatus] = useState<FeedStatus>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  usePolledResource<SessionSummary[]>({
    deps: [intervalMs, teamId, enabled],
    intervalMs,
    enabled,
    createFetch: () => () => api.listSessions(teamId ?? undefined),
    onSuccess: (list) => {
      setSessions(list);
      setStatus("live");
      setLastError(null);
      setLastUpdated(new Date());
    },
    onError: (error) => {
      setStatus("down");
      setLastError(errorMessage(error));
    },
  });

  return { sessions, status, lastError, lastUpdated };
};
