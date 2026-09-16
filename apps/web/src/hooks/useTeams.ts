import { useState } from "react";
import { createApi, type TeamInfo } from "../api";
import { usePolledResource } from "./usePolled";

const api = createApi();

const EMPTY: TeamInfo[] = [];

/**
 * Decision 23 roster: poll GET /teams on a slow cadence — team assignments
 * change at admin speed, not capture speed. Errors keep the last list.
 */
export const useTeams = (intervalMs = 30_000): TeamInfo[] => {
  const [teams, setTeams] = useState<TeamInfo[]>(EMPTY);

  usePolledResource<TeamInfo[]>({
    deps: [intervalMs],
    intervalMs,
    createFetch: () => () => api.teams(),
    onSuccess: setTeams,
    // keep the last roster; retry on the next tick
  });

  return teams;
};
