import { useEffect, useRef, useState } from "react";
import { createApi, type SessionSummary, type StoredEvent } from "../api";
import { sessionTotals } from "../lib/aggregate";
import type { SessionStats } from "../lib/leaderboard";
import { createPoller } from "../lib/poller";
import { buildTimeline, mergeEvents } from "../lib/timeline";

const api = createApi();

/**
 * Event-backed per-session stats (turns, requests, cost est.). Each session's
 * events are fetched incrementally when its last_seq moves; the v1 target is
 * a roster-sized org, so fetching every session's history is acceptable.
 */
export const useSessionCosts = (
  sessions: SessionSummary[],
  intervalMs = 5000,
): Map<string, SessionStats> => {
  const [stats, setStats] = useState<Map<string, SessionStats>>(new Map());
  const accRef = useRef(
    new Map<string, { events: StoredEvent[]; lastSeq: number }>(),
  );
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const mounted = useRef(true);
  const runningRef = useRef(false);

  const runPass = async (): Promise<void> => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      const accs = accRef.current;
      const dirty = sessionsRef.current.filter((s) => {
        const acc = accs.get(s.session_id);
        return !acc || acc.lastSeq < s.last_seq;
      });
      if (dirty.length === 0) return;
      for (const s of dirty) {
        const acc = accs.get(s.session_id);
        const since = acc?.lastSeq ?? 0;
        try {
          const page = await api.eventsSince(s.session_id, since);
          if (!mounted.current) return;
          const events = mergeEvents(acc?.events ?? [], page);
          const lastSeq =
            events.length > 0 ? events[events.length - 1]!.event_seq : since;
          accs.set(s.session_id, { events, lastSeq });
        } catch {
          // keep the previous accumulation; retry on the next pass
        }
      }
      const next = new Map<string, SessionStats>();
      for (const s of sessionsRef.current) {
        const acc = accs.get(s.session_id);
        if (!acc) continue;
        const totals = sessionTotals(acc.events);
        next.set(s.session_id, {
          costUsd: totals.costUsd,
          turns: buildTimeline(acc.events).turns.length,
          requests: totals.requests,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          cacheReadTokens: totals.cacheReadTokens,
        });
      }
      if (mounted.current) setStats(next);
    } finally {
      runningRef.current = false;
    }
  };

  useEffect(() => {
    mounted.current = true;
    const poller = createPoller({ intervalMs, tick: () => runPass() });
    poller.start();
    return () => {
      mounted.current = false;
      poller.stop();
    };
  }, [intervalMs]);

  // Fetch as soon as the session list moves, not just on the interval.
  useEffect(() => {
    void runPass();
  }, [sessions]);

  return stats;
};
