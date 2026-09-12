import { useEffect, useRef, useState } from "react";
import { createApi, type TeamInfo } from "../api";
import { createPoller } from "../lib/poller";

const api = createApi();

const EMPTY: TeamInfo[] = [];

/**
 * Decision 23 roster: poll GET /teams on a slow cadence — team assignments
 * change at admin speed, not capture speed. Errors keep the last list.
 */
export const useTeams = (intervalMs = 30_000): TeamInfo[] => {
  const [teams, setTeams] = useState<TeamInfo[]>(EMPTY);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const poller = createPoller({
      intervalMs,
      tick: async () => {
        const next = await api.teams();
        if (mounted.current) setTeams(next);
      },
      onError: () => {
        // keep the last roster; retry on the next tick
      },
    });
    poller.start();
    return () => {
      mounted.current = false;
      poller.stop();
    };
  }, [intervalMs]);

  return teams;
};
