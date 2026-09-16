import { useEffect, useState } from "react";
import { createReviewApi } from "./api";
import { clearToken, storedToken } from "./auth";
import { useSessions } from "./hooks/useSessions";
import { useTeams } from "./hooks/useTeams";
import { clock } from "./lib/format";
import type { Route } from "./lib/router";
import { useHashRoute } from "./lib/router";
import { BackToTop } from "./views/BackToTop";
import { DeveloperDetail } from "./views/DeveloperDetail";
import { LeaderboardView } from "./views/LeaderboardView";
import { AdminView } from "./views/AdminView";
import { MeView } from "./views/MeView";
import { NotAuthorized } from "./views/NotAuthorized";
import { SessionDetail } from "./views/SessionDetail";
import { SessionList } from "./views/SessionList";
import { SignInGate, type Role } from "./views/SignIn";

/** Saved-token lifecycle: anon → checking (verifying against /me) → signed-in. */
type AuthState =
  | { status: "anon" }
  | { status: "checking" }
  | { status: "signed-in"; user: string; role: Role };

export const App = () => {
  const [auth, setAuth] = useState<AuthState>(() =>
    storedToken() ? { status: "checking" } : { status: "anon" },
  );
  // verify the persisted token once on load; a stale token falls back to the gate
  useEffect(() => {
    if (!storedToken()) return;
    void createReviewApi(storedToken)
      .me()
      .then((info) =>
        setAuth({
          status: "signed-in",
          user: info.user,
          role: info.role,
        }),
      )
      .catch(() => {
        clearToken();
        setAuth({ status: "anon" });
      });
  }, []);
  const { route, sessionId, userId } = useHashRoute();

  // Every route — admin included — now sits behind the one user-token gate;
  // the role decides what renders inside.
  const signedIn = auth.status === "signed-in";
  if (!signedIn) {
    return auth.status === "checking" ? (
      <p className="empty">verifying saved token…</p>
    ) : (
      <SignInGate
        onSignedIn={(user, role) =>
          setAuth({ status: "signed-in", user, role })
        }
      />
    );
  }
  return (
    <Dashboard
      user={auth.user}
      role={auth.role}
      route={route}
      sessionId={sessionId}
      userId={userId}
      onSignOut={() => {
        clearToken();
        setAuth({ status: "anon" });
      }}
    />
  );
};

/** Everything behind the gate: header, live feed, and the role-scoped routes. */
const Dashboard = ({
  user,
  role,
  route,
  sessionId,
  userId,
  onSignOut,
}: {
  user: string;
  role: Role;
  route: Route;
  sessionId: string | null;
  userId: string | null;
  onSignOut: () => void;
}) => {
  const isAdmin = role === "admin";
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const feed = useSessions(
    teamFilter === "all" ? null : teamFilter,
    5000,
    true,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Team-scoped DRI filter: the roster feeds the admin's sessions dropdown.
  // Members see only their own sessions, so the filter (and the roster) is
  // admin-only UI; the hook itself polls slowly and keeps the last roster
  // across errors.
  const teams = useTeams();

  // Follow the newest session until the operator picks one.
  useEffect(() => {
    if (selectedId === null && feed.sessions.length > 0)
      setSelectedId(feed.sessions[0]!.session_id);
  }, [selectedId, feed.sessions]);

  // A hash deep link (e.g. from the admin sessions panel) wins over the default.
  useEffect(() => {
    if (sessionId !== null) setSelectedId(sessionId);
  }, [sessionId]);

  // The browser tab mirrors the route so history entries read at a glance.
  useEffect(() => {
    const label =
      route === "leaderboard"
        ? userId
          ? "Developer"
          : "Leaderboard"
        : route === "admin"
          ? "Admin"
          : route === "me"
            ? "Me"
            : "Sessions";
    document.title = `${label} · slopwatch`;
  }, [route, userId]);

  const selected =
    feed.sessions.find((s) => s.session_id === selectedId) ?? null;

  return (
    <>
      <header>
        <a className="brand" href="#/sessions">
          <span className="pulse" />
          slopwatch
        </a>
        <nav className="menu">
          <a href="#/sessions" className={route === "sessions" ? "active" : ""}>
            Sessions
          </a>
          {isAdmin && (
            <a
              href="#/leaderboard"
              className={route === "leaderboard" ? "active" : ""}
            >
              Leaderboard
            </a>
          )}
          {isAdmin && (
            <a href="#/admin" className={route === "admin" ? "active" : ""}>
              Admin
            </a>
          )}
          <a href="#/me" className={route === "me" ? "active" : ""}>
            Me
          </a>
        </nav>
        <span className={`live-pill ${feed.status}`}>
          {feed.status === "live" && <span className="pulse" />}
          {feed.status === "live"
            ? `live · ${feed.lastUpdated ? clock(feed.lastUpdated.toISOString()) : ""}`
            : feed.status === "down"
              ? "connection lost"
              : "connecting…"}
        </span>
        {/* The avatar chip is the human anchor — profile, usage, and sign-out live behind it. */}
        <a className="user-chip" href="#/me" title="My profile">
          <span className="avatar">{user.slice(0, 1).toUpperCase()}</span>
          <span className="chip-name">{user}</span>
        </a>
      </header>
      {route === "leaderboard" ? (
        isAdmin ? (
          <main className="full">
            <section>
              <div className="stage">
                {userId ? (
                  <DeveloperDetail userId={userId} />
                ) : (
                  <>
                    <h2 className="page-title">Developer leaderboard</h2>
                    <p className="page-sub">
                      Local-day spend ranks first; click a column header to
                      re-sort, a row to open the developer's history.
                    </p>
                    <LeaderboardView sessions={feed.sessions} />
                  </>
                )}
              </div>
            </section>
          </main>
        ) : (
          <NotAuthorized route="leaderboard" />
        )
      ) : route === "admin" ? (
        isAdmin ? (
          <main className="full">
            <section>
              <div className="stage">
                <AdminView />
              </div>
            </section>
          </main>
        ) : (
          <NotAuthorized route="admin" />
        )
      ) : route === "me" ? (
        <main className="full">
          <section>
            <div className="stage narrow">
              <MeView onSignOut={onSignOut} />
            </div>
          </section>
        </main>
      ) : (
        <main>
          <aside>
            {isAdmin && (
              <div className="rail-head">
                <span className="rail-count">
                  {feed.sessions.length}{" "}
                  {feed.sessions.length === 1 ? "session" : "sessions"}
                </span>
                <label className="filter-pill">
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 12 12"
                    fill="none"
                    aria-hidden
                  >
                    <path
                      d="M1.5 2.5h9L7.3 6.4v3.2L4.7 8.2V6.4L1.5 2.5Z"
                      stroke="currentColor"
                      strokeWidth="1.1"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <select
                    value={teamFilter}
                    onChange={(e) => {
                      setTeamFilter(e.target.value);
                      setSelectedId(null);
                    }}
                    aria-label="Filter sessions by team"
                  >
                    <option value="all">All teams</option>
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                    <option value="unassigned">Unassigned</option>
                  </select>
                </label>
              </div>
            )}
            <SessionList
              sessions={feed.sessions}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </aside>
          <section>
            <div className="stage">
              {selected ? (
                <SessionDetail key={selected.session_id} summary={selected} />
              ) : (
                <p className="empty">
                  No sessions yet — they appear here as agents work.
                </p>
              )}
            </div>
          </section>
        </main>
      )}
      {/* One rocket for the whole dashboard: every page scrolls the document,
          so a single document-mode button covers all routes. */}
      <BackToTop />
    </>
  );
};
