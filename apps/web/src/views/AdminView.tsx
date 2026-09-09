import { useEffect, useState } from "react";
import {
  createAdminApi,
  type AdminApi,
  type AdminHealth,
  ApiError,
} from "../api";
import { clock } from "../lib/format";
import { createPoller } from "../lib/poller";
import { AdminSessionsPanel } from "./AdminSessionsPanel";
import { AdminUsersPanel } from "./AdminUsersPanel";

const TOKEN_KEY = "slopwatch.admin-token";

export type PollError = { message: string; status: number | null };

const toPollError = (e: unknown): PollError => ({
  message: e instanceof Error ? e.message : String(e),
  status: e instanceof ApiError ? e.status : null,
});

/**
 * Poll an admin resource on the decision-4 contract (tick ~5s while
 * visible, never overlap, survive errors). refreshKey bumps re-arm the
 * poller so mutations surface immediately.
 */
export const usePolled = <T,>(
  fetcher: () => Promise<T>,
  refreshKey: number,
): { data: T | null; error: PollError | null } => {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<PollError | null>(null);
  useEffect(() => {
    let mounted = true;
    const poller = createPoller({
      intervalMs: 5000,
      tick: async () => {
        const next = await fetcher();
        if (!mounted) return;
        setData(next);
        setError(null);
      },
      onError: (e) => {
        if (mounted) setError(toPollError(e));
      },
    });
    poller.start();
    return () => {
      mounted = false;
      poller.stop();
    };
    // fetcher closes over the current api/token; refreshKey marks changes
  }, [refreshKey]);
  return { data, error };
};

const TokenGate = ({ onSave }: { onSave: (token: string) => void }) => {
  const [value, setValue] = useState("");
  return (
    <section className="admin">
      <h2>admin sign-in</h2>
      <p className="dim">
        Enter the operator token (<code>SLOPWATCH_ADMIN_TOKEN</code>). It is
        kept in this browser's localStorage only.
      </p>
      <form
        className="admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSave(value.trim());
        }}
      >
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="admin token"
          autoFocus
        />
        <button type="submit">sign in</button>
      </form>
    </section>
  );
};

const HealthPanel = ({
  health,
}: {
  health: { data: AdminHealth | null; error: PollError | null };
}) => (
  <>
    <h2>system health</h2>
    {health.error && <p className="banner-error">{health.error.message}</p>}
    {health.data && (
      <dl className="facts">
        <div>
          <dt>database</dt>
          <dd className="state live">ok</dd>
        </div>
        <div>
          <dt>sessions</dt>
          <dd>{health.data.sessions}</dd>
        </div>
        <div>
          <dt>events</dt>
          <dd>{health.data.events}</dd>
        </div>
        <div>
          <dt>last event received</dt>
          <dd>
            {health.data.last_event_at ? clock(health.data.last_event_at) : "—"}
          </dd>
        </div>
      </dl>
    )}
  </>
);

type AdminTab = "users" | "sessions" | "health";

const AdminHome = ({
  api,
  onSignOut,
}: {
  api: AdminApi;
  onSignOut: () => void;
}) => {
  const [tab, setTab] = useState<AdminTab>("users");
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey((k) => k + 1);
  const health = usePolled(() => api.health(), refreshKey);
  return (
    <section className="admin">
      <nav className="tabs">
        <button
          className={tab === "users" ? "active" : ""}
          onClick={() => setTab("users")}
        >
          users
        </button>
        <button
          className={tab === "sessions" ? "active" : ""}
          onClick={() => setTab("sessions")}
        >
          sessions
        </button>
        <button
          className={tab === "health" ? "active" : ""}
          onClick={() => setTab("health")}
        >
          health
        </button>
        <button className="signout" onClick={onSignOut}>
          sign out
        </button>
      </nav>
      {tab === "users" ? (
        <AdminUsersPanel api={api} refreshKey={refreshKey} refresh={refresh} />
      ) : tab === "sessions" ? (
        <AdminSessionsPanel
          api={api}
          refreshKey={refreshKey}
          refresh={refresh}
        />
      ) : (
        <HealthPanel health={health} />
      )}
    </section>
  );
};

/** Admin plane entry: token gate, then the users/health tabs. */
export const AdminView = () => {
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem(TOKEN_KEY),
  );
  if (token === null)
    return (
      <TokenGate
        onSave={(t) => {
          localStorage.setItem(TOKEN_KEY, t);
          setToken(t);
        }}
      />
    );
  return (
    <AdminHome
      api={createAdminApi(() => token)}
      onSignOut={() => {
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
      }}
    />
  );
};
