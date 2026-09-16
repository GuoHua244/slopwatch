import { useState } from "react";
import { createApi, type RollupsSnapshot } from "../api";
import { errorMessage } from "../lib/format";
import { usePolledResource } from "./usePolled";

const api = createApi();

const EMPTY: RollupsSnapshot = {
  totals: [],
  model_totals: [],
  daily: [],
  model_daily: [],
  user_hourly: [],
  model_hourly: [],
};

/**
 * Decision 18: poll GET /rollups and hand back the snapshot. `days` sizes the
 * daily window (the leaderboard works off all-time totals + 8 days: today and
 * its trailing week); the hourly window covers the sparkline; `teamId`
 * scopes the whole snapshot server-side to one team. Callers pass literals,
 * so the primitive deps only change when the window really does. A failed
 * tick keeps the last snapshot and surfaces the reason in `lastError`.
 */
export const useRollups = (
  {
    days,
    hours,
    teamId,
  }: { days?: number; hours?: number; teamId?: string } = {},
  intervalMs = 5000,
): { snapshot: RollupsSnapshot; lastError: string | null } => {
  const [snapshot, setSnapshot] = useState<RollupsSnapshot>(EMPTY);
  const [lastError, setLastError] = useState<string | null>(null);

  usePolledResource<RollupsSnapshot>({
    deps: [intervalMs, days, hours, teamId],
    intervalMs,
    createFetch: () => () => api.rollups({ days, hours, teamId }),
    onSuccess: (next) => {
      setSnapshot(next);
      setLastError(null);
    },
    onError: (error) => setLastError(errorMessage(error)),
  });

  return { snapshot, lastError };
};
