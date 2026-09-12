import { useEffect, useRef, useState } from "react";
import { createApi, type RollupsSnapshot } from "../api";
import { createPoller } from "../lib/poller";

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
 * its trailing week); the hourly window covers the sparkline.
 */
export const useRollups = (
  params: { days?: number; hours?: number } = {},
  intervalMs = 5000,
): RollupsSnapshot => {
  const [snapshot, setSnapshot] = useState<RollupsSnapshot>(EMPTY);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const poller = createPoller({
      intervalMs,
      tick: async () => {
        try {
          const next = await api.rollups(params);
          if (mounted.current) setSnapshot(next);
        } catch {
          // keep the last snapshot; retry on the next tick
        }
      },
    });
    poller.start();
    return () => {
      mounted.current = false;
      poller.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, params.days]);

  return snapshot;
};
