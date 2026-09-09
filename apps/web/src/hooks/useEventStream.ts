import { useEffect, useRef, useState } from "react";
import { createApi, type StoredEvent } from "../api";
import { createPoller } from "../lib/poller";
import { mergeEvents } from "../lib/timeline";
import type { FeedStatus } from "./useSessions";

const api = createApi();

export type EventStream = {
  events: StoredEvent[];
  status: FeedStatus;
  lastError: string | null;
};

/**
 * Decision 8: accumulate a session's events by pulling
 * GET /sessions/:id/events?since_seq=N every ~5s (and on tab focus).
 */
export const useEventStream = (
  sessionId: string | null,
  intervalMs = 5000,
): EventStream => {
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [status, setStatus] = useState<FeedStatus>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    setEvents([]);
    setStatus("connecting");
    setLastError(null);
    let lastSeq = 0;
    if (!sessionId) return () => {};
    const poller = createPoller({
      intervalMs,
      tick: async () => {
        const page = await api.eventsSince(sessionId, lastSeq);
        if (!mounted.current) return;
        if (page.length > 0) {
          lastSeq = page[page.length - 1]!.event_seq;
          setEvents((prev) => mergeEvents(prev, page));
        }
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
  }, [sessionId, intervalMs]);

  return { events, status, lastError };
};
