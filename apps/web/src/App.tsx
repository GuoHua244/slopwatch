import { useEffect, useState } from "react";
import { createApi, createReviewApi, type TeamInfo } from "./api";
import { clearToken, saveToken, storedToken } from "./auth";
import { useSessions } from "./hooks/useSessions";
import { clock } from "./lib/format";
import { DeveloperDetail } from "./views/DeveloperDetail";
import { LeaderboardView } from "./views/LeaderboardView";
import { AdminView } from "./views/AdminView";
import { SessionDetail } from "./views/SessionDetail";
import { SessionList } from "./views/SessionList";

type Route = "sessions" | "leaderboard" | "admin";

/** "#/sessions/sess_x" deep-links into a session detail, "#/leaderboard/dev" into a developer. */
const parseHash = (
  hash: string,
): { route: Route; sessionId: string | null; userId: string | null } => {
  const path = hash.replace(/^#\/?/, "");
  const session = path.match(/^sessions\/(.+)$/);
  if (session)
    return {
      route: "sessions",
      sessionId: decodeURIComponent(session[1]!),
      userId: null,
    };
  const developer = path.match(/^leaderboard\/(.+)$/);
  if (developer)
    return {
      route: "leaderboard",
      sessionId: null,
      userId: decodeURIComponent(developer[1]!),
    };
  if (path === "leaderboard")
    return { route: "leaderboard", sessionId: null, userId: null };
  if (path === "admin")
    return { route: "admin", sessionId: null, userId: null };
  return { route: "sessions", sessionId: null, userId: null };
};

const useHashRoute = (): {
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

/**
 * Sign-in gate (v2 decision 22 / ADR 0003): the dashboard renders nothing
 * until a user token verifies against GET /me — reads are no longer anonymous.
 */
const SignInGate = ({ onSignedIn }: { onSignedIn: (user: string) => void }) => {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  return (
    <section className="admin">
      <h2>sign in</h2>
      <p className="dim">
        Paste your Slopwatch user token — the same one your listener uses. It is
        kept in this browser's localStorage only.
      </p>
      <form
        className="admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          const token = value.trim();
          if (!token) return;
          setChecking(true);
          setError(null);
          void createReviewApi(() => token)
            .me()
            .then((info) => {
              saveToken(token);
              onSignedIn(info.user);
            })
            .catch(() => {
              setError("that token did not verify — check it and try again");
            })
            .finally(() => setChecking(false));
        }}
      >
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="user token"
          autoFocus
        />
        <button type="submit" disabled={checking}>
          {checking ? "checking…" : "sign in"}
        </button>
      </form>
      {error && <p className="banner-error">{error}</p>}
    </section>
  );
};

/** Saved-token lifecycle: anon → checking (verifying against /me) → signed-in. */
type AuthState =
  | { status: "anon" }
  | { status: "checking" }
  | { status: "signed-in"; user: string };

export const App = () => {
  // The admin route keeps its own separate gate; everything else needs a
  // verified user token first.
  const [auth, setAuth] = useState<AuthState>(() =>
    storedToken() ? { status: "checking" } : { status: "anon" },
  );
  // verify the persisted token once on load; a stale token falls back to the gate
  useEffect(() => {
    if (!storedToken()) return;
    void createReviewApi(storedToken)
      .me()
      .then((info) => setAuth({ status: "signed-in", user: info.user }))
      .catch(() => {
        clearToken();
        setAuth({ status: "anon" });
      });
  }, []);
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const feed = useSessions(teamFilter === "all" ? null : teamFilter);
  const { route, sessionId, userId } = useHashRoute();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Team-scoped DRI filter: the roster feeds the sessions dropdown; fetched
  // once per sign-in.
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  useEffect(() => {
    if (auth.status !== "signed-in") return;
    void createApi()
      .teams()
      .then(setTeams)
      .catch(() => {});
  }, [auth.status]);

  // Follow the newest session until the operator picks one.
  useEffect(() => {
    if (selectedId === null && feed.sessions.length > 0)
      setSelectedId(feed.sessions[0]!.session_id);
  }, [selectedId, feed.sessions]);

  // A hash deep link (e.g. from the admin sessions panel) wins over the default.
  useEffect(() => {
    if (sessionId !== null) setSelectedId(sessionId);
  }, [sessionId]);

  // Until /me verifies the saved token, render the gate (or a verifying note) —
  // never the dashboard; the admin route keeps its own separate gate.
  if (auth.status !== "signed-in" && route !== "admin") {
    return auth.status === "checking" ? (
      <p className="empty">verifying saved token…</p>
    ) : (
      <SignInGate
        onSignedIn={(user) => setAuth({ status: "signed-in", user })}
      />
    );
  }

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
        {auth.status === "signed-in" && (
          <span className="dim">
            {auth.user}
            <button
              className="signout"
              onClick={() => {
                clearToken();
                setAuth({ status: "anon" });
              }}
            >
              sign out
            </button>
          </span>
        )}
      </header>
      {route === "leaderboard" ? (
        <main className="full">
          <section>
            {userId ? (
              <DeveloperDetail userId={userId} sessions={feed.sessions} />
            ) : (
              <>
                <h2>developer leaderboard</h2>
                <LeaderboardView sessions={feed.sessions} />
              </>
            )}
          </section>
        </main>
      ) : route === "admin" ? (
        <main className="full">
          <AdminView />
        </main>
      ) : (
        <main>
          <aside>
            <form className="admin-form" onSubmit={(e) => e.preventDefault()}>
              <label className="dim">
                team{" "}
                <select
                  value={teamFilter}
                  onChange={(e) => {
                    setTeamFilter(e.target.value);
                    setSelectedId(null);
                  }}
                >
                  <option value="all">all</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                  <option value="unassigned">unassigned</option>
                </select>
              </label>
            </form>
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
