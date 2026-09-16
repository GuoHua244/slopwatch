import { useEffect, useState } from "react";

export type Route = "sessions" | "leaderboard" | "admin" | "me";

/** decodeURIComponent that never throws — a malformed hash (e.g. a truncated
 * pasted URL with a stray %) falls back to the raw text instead of throwing
 * during render, which would white-screen the whole app. */
export const decodeHash = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/** "#/sessions/sess_x" deep-links into a session detail, "#/leaderboard/dev" into a developer. */
export const parseHash = (
  hash: string,
): { route: Route; sessionId: string | null; userId: string | null } => {
  const path = hash.replace(/^#\/?/, "");
  const session = path.match(/^sessions\/(.+)$/);
  if (session)
    return {
      route: "sessions",
      sessionId: decodeHash(session[1]!),
      userId: null,
    };
  const developer = path.match(/^leaderboard\/(.+)$/);
  if (developer)
    return {
      route: "leaderboard",
      sessionId: null,
      userId: decodeHash(developer[1]!),
    };
  if (path === "leaderboard")
    return { route: "leaderboard", sessionId: null, userId: null };
  if (path === "admin")
    return { route: "admin", sessionId: null, userId: null };
  if (path === "me") return { route: "me", sessionId: null, userId: null };
  return { route: "sessions", sessionId: null, userId: null };
};

export const useHashRoute = (): {
  route: Route;
  sessionId: string | null;
  userId: string | null;
} => {
  const [state, setState] = useState(parseHash(window.location.hash));
  useEffect(() => {
    const onHashChange = () => setState(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return state;
};
