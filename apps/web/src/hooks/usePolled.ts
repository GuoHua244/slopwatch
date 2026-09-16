import { useEffect, useState, type DependencyList } from "react";
import { ApiError } from "../api";
import { errorMessage } from "../lib/format";
import { createPoller } from "../lib/poller";

export type PollError = { message: string; status: number | null };

export const toPollError = (e: unknown): PollError => ({
  message: errorMessage(e),
  status: e instanceof ApiError ? e.status : null,
});

export type PolledResourceOptions<T> = {
  /**
   * Built once per effect generation, so tick-local state (a since-seq
   * cursor, say) resets together with the generation.
   */
  createFetch: () => () => Promise<T>;
  /** Commit a successful fetch; the core guards it with the alive flag. */
  onSuccess: (data: T) => void;
  /** Commit a failed fetch; omit for keep-last-value resources. */
  onError?: (error: unknown) => void;
  /** Synchronous state reset at generation start, before the first tick. */
  reset?: () => void;
  /** What marks a new generation: team filter, session id, refresh key… */
  deps: DependencyList;
  intervalMs?: number;
  /** False (pre-auth, no session selected) skips polling entirely. */
  enabled?: boolean;
};

/**
 * The shared polled-resource skeleton under every data hook (decision 4):
 * each `deps` change starts a new generation with its own `alive` flag, so a
 * response still in flight from the previous generation can never write into
 * this one's state — a shared ref would be flipped back to true by the new
 * effect before the stale fetch lands. Ticks follow the poller contract:
 * ~every intervalMs while the tab is visible, never overlapping, surviving
 * errors.
 */
export const usePolledResource = <T>({
  createFetch,
  onSuccess,
  onError,
  reset,
  deps,
  intervalMs = 5000,
  enabled = true,
}: PolledResourceOptions<T>): void => {
  useEffect(() => {
    // Per-effect flag, not a shared ref (see above).
    let alive = true;
    reset?.();
    if (!enabled) return () => {};
    const fetch = createFetch();
    const poller = createPoller({
      intervalMs,
      tick: async () => {
        const next = await fetch();
        if (!alive) return;
        onSuccess(next);
      },
      onError: (error) => {
        if (!alive) return;
        onError?.(error);
      },
    });
    poller.start();
    return () => {
      alive = false;
      poller.stop();
    };
    // The fetcher closes over the current api/token; deps mark changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
};

/**
 * Poll an admin resource on the decision-4 contract (tick ~5s while
 * visible, never overlap, survive errors). The effect re-arms whenever a
 * dependency changes — panels pass [refreshKey] so mutations surface
 * immediately; the audit panel adds its filter/page state.
 */
export const usePolled = <T>(
  fetcher: () => Promise<T>,
  deps: DependencyList,
): { data: T | null; error: PollError | null } => {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<PollError | null>(null);
  usePolledResource<T>({
    deps,
    createFetch: () => fetcher,
    onSuccess: (next) => {
      setData(next);
      setError(null);
    },
    onError: (e) => setError(toPollError(e)),
  });
  return { data, error };
};
