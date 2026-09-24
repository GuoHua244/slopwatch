import { useRef, useState } from "react";
import { createRetroApi, type RetroApi, type RetroRow } from "../api";
import { storedToken } from "../auth";
import { errorMessage } from "../lib/format";
import type { FeedStatus } from "./useSessions";
import { usePolledResource } from "./usePolled";

export type RetroState = {
  api: RetroApi;
  retros: RetroRow[];
  status: FeedStatus;
  lastError: string | null;
  /** Force an immediate re-poll after a mutation. */
  refresh: () => void;
};

/**
 * ADR 0008 data for one session: the retrospective runs, polled on the
 * decision-4 contract so runs triggered elsewhere (or finishing server-side)
 * surface within one interval.
 */
export const useRetrospectives = (
  sessionId: string | null,
  intervalMs = 5000,
): RetroState => {
  const api = useRef(createRetroApi(storedToken)).current;
  const [retros, setRetros] = useState<RetroRow[]>([]);
  const [status, setStatus] = useState<FeedStatus>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  usePolledResource<RetroRow[]>({
    deps: [sessionId, intervalMs, api, version],
    intervalMs,
    enabled: sessionId !== null,
    reset: () => {
      setRetros([]);
      setStatus("connecting");
    },
    createFetch: () => async () => api.list(sessionId!),
    onSuccess: (rows) => {
      setRetros(rows);
      setStatus("live");
      setLastError(null);
    },
    onError: (error) => {
      setStatus("down");
      setLastError(errorMessage(error));
    },
  });

  return {
    api,
    retros,
    status,
    lastError,
    refresh: () => setVersion((v) => v + 1),
  };
};
