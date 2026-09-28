import {
  authedClient,
  defaultFetch,
  getJson,
  unwrapJson,
  type FetchLike,
} from "./http";
import type { RetroAngleInfo, RetroEstimate, RetroRow } from "./types";

export type RetroApi = {
  /** The org's preset angles plus the built-in free-form mode, in order. */
  angles(): Promise<RetroAngleInfo[]>;
  /** A session's runs, newest first; visibility follows the read plane. */
  list(sessionId: string): Promise<RetroRow[]>;
  /** Trigger one run; 409s surface as ApiError (no credentials, one per user). */
  trigger(
    sessionId: string,
    angle: string,
    supplement?: string,
  ): Promise<{ retro: RetroRow; estimate: RetroEstimate }>;
  /** Store the signed-in user's own LLM credentials; a blank key keeps the old one. */
  setLlm(config: {
    endpoint: string;
    model: string;
    api_key?: string;
  }): Promise<void>;
  clearLlm(): Promise<void>;
};

/**
 * Retrospective-plane client (ADR 0008). Runs execute server-side on the
 * triggering user's own LLM key; every call carries the browser's user
 * token, and scope enforcement is server-side.
 */
export const createRetroApi = (
  userToken: () => string | null,
  doFetch: FetchLike = defaultFetch,
): RetroApi => {
  const { auth, authedJson } = authedClient(userToken);
  return {
    angles: async () =>
      (
        await getJson<{ angles: RetroAngleInfo[] }>(
          doFetch,
          "/retrospectives/angles",
          auth(),
        )
      ).angles,
    list: async (sessionId) =>
      (
        await getJson<{ retrospectives: RetroRow[] }>(
          doFetch,
          `/sessions/${encodeURIComponent(sessionId)}/retrospectives`,
          auth(),
        )
      ).retrospectives,
    trigger: async (sessionId, angle, supplement) =>
      unwrapJson(
        doFetch,
        `/sessions/${encodeURIComponent(sessionId)}/retrospectives`,
        authedJson("POST", { angle, ...(supplement ? { supplement } : {}) }),
        "POST",
      ),
    setLlm: async (config) => {
      await unwrapJson(doFetch, "/me/llm", authedJson("PUT", config), "PUT");
    },
    clearLlm: async () => {
      await unwrapJson(
        doFetch,
        "/me/llm",
        auth({ method: "DELETE" }),
        "DELETE",
      );
    },
  };
};
