import { useEffect, useRef, useState } from "react";
import { createApi, type SessionSummary } from "../api";
import { createPoller } from "../lib/poller";

export type FeedStatus = "connecting" | "live" | "down";

export type SessionFeed = {
  sessions: SessionSummary[];
  status: FeedStatus;
  lastError: string | null;
  lastUpdated: Date | null;
};

const api = createApi();

/** Decision 4: poll GET /sessions every ~5s and on tab focus. */
export const useSessions = (intervalMs = 5000): SessionFeed => {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [status, setStatus] = useState<FeedStatus>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const poller = createPoller({
      intervalMs,
      tick: async () => {
        try {
          const list = await api.listSessions();
          if (!mounted.current) return;
          setSessions(list);
          setStatus("live");
          setLastError(null);
          setLastUpdated(new Date());
        } catch (error) {
          if (!mounted.current) return;
          setStatus("down");
          setLastError(error instanceof Error ? error.message : String(error));
        }
      },
    });
    poller.start();
    return () => {
      mounted.current = false;
      poller.stop();
    };
  }, [intervalMs]);

  return { sessions, status, lastError, lastUpdated };
};
