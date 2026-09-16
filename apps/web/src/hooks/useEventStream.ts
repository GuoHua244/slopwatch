import { useState } from "react";
import { createApi, type StoredEvent } from "../api";
import { errorMessage } from "../lib/format";
import { mergeEvents } from "../lib/timeline";
import type { FeedStatus } from "./useSessions";
import { usePolledResource } from "./usePolled";

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

  usePolledResource<StoredEvent[]>({
    deps: [sessionId, intervalMs],
    intervalMs,
    enabled: sessionId !== null,
    // New generation: the previous session's accumulated page must not leak
    // into this one's timeline.
    reset: () => {
      setEvents([]);
      setStatus("connecting");
      setLastError(null);
    },
    createFetch: () => {
      // Per-generation cursor: pages continue from the newest seq this
      // generation has actually seen.
      let lastSeq = 0;
      return async () => {
        const page = await api.eventsSince(sessionId!, lastSeq);
        if (page.length > 0) lastSeq = page[page.length - 1]!.event_seq;
        return page;
      };
    },
    onSuccess: (page) => {
      if (page.length > 0) setEvents((prev) => mergeEvents(prev, page));
      setStatus("live");
      setLastError(null);
    },
    onError: (error) => {
      setStatus("down");
      setLastError(errorMessage(error));
    },
  });

  return { events, status, lastError };
};
