import { useEffect, useState } from "react";
import { useSessions } from "./hooks/useSessions";
import { clock } from "./lib/format";
import { LeaderboardView } from "./views/LeaderboardView";
import { AdminView } from "./views/AdminView";
import { SessionDetail } from "./views/SessionDetail";
import { SessionList } from "./views/SessionList";

type Route = "sessions" | "leaderboard" | "admin";

/** "#/sessions/sess_x" deep-links straight into a session detail. */
const parseHash = (
  hash: string,
): { route: Route; sessionId: string | null } => {
  const path = hash.replace(/^#\/?/, "");
  const session = path.match(/^sessions\/(.+)$/);
  if (session)
    return { route: "sessions", sessionId: decodeURIComponent(session[1]!) };
  if (path === "leaderboard") return { route: "leaderboard", sessionId: null };
  if (path === "admin") return { route: "admin", sessionId: null };
  return { route: "sessions", sessionId: null };
};

const useHashRoute = (): {
  route: Route;
  sessionId: string | null;
} => {
  const [state, setState] = useState(parseHash(window.location.hash));
  useEffect(() => {
    const onHashChange = () => setState(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return state;
};

export const App = () => {
  const feed = useSessions();
  const { route, sessionId } = useHashRoute();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Follow the newest session until the operator picks one.
  useEffect(() => {
    if (selectedId === null && feed.sessions.length > 0)
      setSelectedId(feed.sessions[0]!.session_id);
  }, [selectedId, feed.sessions]);

  // A hash deep link (e.g. from the admin sessions panel) wins over the default.
  useEffect(() => {
    if (sessionId !== null) setSelectedId(sessionId);
  }, [sessionId]);

  const selected =
    feed.sessions.find((s) => s.session_id === selectedId) ?? null;

  return (
    <>
      <header>
        <h1>slopwatch</h1>
        <nav className="menu">
          <a href="#/sessions" className={route === "sessions" ? "active" : ""}>
            sessions
          </a>
          <a
            href="#/leaderboard"
            className={route === "leaderboard" ? "active" : ""}
          >
            leaderboard
          </a>
          <a href="#/admin" className={route === "admin" ? "active" : ""}>
            admin
          </a>
        </nav>
        <span className={`status ${feed.status}`}>
          {feed.status === "live"
            ? `live · ${feed.lastUpdated ? clock(feed.lastUpdated.toISOString()) : ""}`
            : feed.status === "down"
              ? `connection lost${feed.lastError ? ` · ${feed.lastError}` : ""}`
              : "connecting…"}
        </span>
      </header>
      {route === "leaderboard" ? (
        <main className="full">
          <section>
            <h2>developer leaderboard</h2>
            <LeaderboardView sessions={feed.sessions} />
          </section>
        </main>
      ) : route === "admin" ? (
        <main className="full">
          <AdminView />
        </main>
      ) : (
        <main>
          <aside>
            <SessionList
              sessions={feed.sessions}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </aside>
          <section>
            {selected ? (
              <SessionDetail summary={selected} />
            ) : (
              <p className="empty">no sessions yet</p>
            )}
          </section>
        </main>
      )}
    </>
  );
};
