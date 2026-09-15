import { useEffect, useState } from "react";
import {
  createAdminApi,
  type AdminApi,
  type AdminHealth,
  type QuarantineRow,
  ApiError,
} from "../api";
import { storedToken } from "../auth";
import { clock } from "../lib/format";
import { createPoller } from "../lib/poller";
import { AdminSessionsPanel } from "./AdminSessionsPanel";
import { AdminSettingsPanel } from "./AdminSettingsPanel";
import { AdminTeamsPanel } from "./AdminTeamsPanel";
import { AdminUsersPanel } from "./AdminUsersPanel";

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

const HealthPanel = ({
  health,
  quarantine,
}: {
  health: { data: AdminHealth | null; error: PollError | null };
  quarantine: { data: QuarantineRow[] | null; error: PollError | null };
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
        <div>
          <dt>quarantined lines</dt>
          <dd>
            {health.data.quarantine_total}
            {health.data.quarantine_24h > 0
              ? ` (${health.data.quarantine_24h} in 24h)`
              : ""}
          </dd>
        </div>
        <div>
          <dt>last quarantine</dt>
          <dd>
            {health.data.last_quarantine_at
              ? clock(health.data.last_quarantine_at)
              : "—"}
          </dd>
        </div>
      </dl>
    )}
    <h3>recent quarantined lines</h3>
    <p className="dim">
      Listener lines that could not be normalized (v2 schema-drift quarantine).
      A nonzero count means an agent wrote something the adapter does not know.
    </p>
    {quarantine.error && (
      <p className="banner-error">{quarantine.error.message}</p>
    )}
    {quarantine.data !== null &&
      (quarantine.data.length === 0 ? (
        <p className="dim">nothing quarantined — capture is clean</p>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>when</th>
              <th>agent</th>
              <th>reason</th>
              <th>line (capped)</th>
            </tr>
          </thead>
          <tbody>
            {quarantine.data.map((row) => (
              <tr key={row.seq}>
                <td>{clock(row.created_at)}</td>
                <td>{row.agent}</td>
                <td>
                  {row.reason}
                  <span className="dim"> · {row.session_id}</span>
                </td>
                <td className="raw-line">{row.line.slice(0, 240)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
  </>
);

type AdminTab = "users" | "teams" | "sessions" | "settings" | "health";

const AdminHome = ({ api }: { api: AdminApi }) => {
  const [tab, setTab] = useState<AdminTab>("users");
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey((k) => k + 1);
  const health = usePolled(() => api.health(), refreshKey);
  const quarantine = usePolled(() => api.quarantine(50), refreshKey);

  // A revoked token or a role pulled mid-session shows as one honest banner
  // instead of five panels each 401/403-ing.
  const gate =
    health.error?.status === 401
      ? "your user token is no longer valid — sign in again from the me page"
      : health.error?.status === 403
        ? "the admin role is required for this area"
        : null;

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
          className={tab === "teams" ? "active" : ""}
          onClick={() => setTab("teams")}
        >
          teams
        </button>
        <button
          className={tab === "sessions" ? "active" : ""}
          onClick={() => setTab("sessions")}
        >
          sessions
        </button>
        <button
          className={tab === "settings" ? "active" : ""}
          onClick={() => setTab("settings")}
        >
          settings
        </button>
        <button
          className={tab === "health" ? "active" : ""}
          onClick={() => setTab("health")}
        >
          health
        </button>
      </nav>
      {gate ? (
        <p className="banner-error">{gate}</p>
      ) : tab === "users" ? (
        <AdminUsersPanel api={api} refreshKey={refreshKey} refresh={refresh} />
      ) : tab === "teams" ? (
        <AdminTeamsPanel api={api} refreshKey={refreshKey} refresh={refresh} />
      ) : tab === "sessions" ? (
        <AdminSessionsPanel
          api={api}
          refreshKey={refreshKey}
          refresh={refresh}
        />
      ) : tab === "settings" ? (
        <AdminSettingsPanel
          api={api}
          refreshKey={refreshKey}
          refresh={refresh}
        />
      ) : (
        <HealthPanel health={health} quarantine={quarantine} />
      )}
    </section>
  );
};

/**
 * Admin plane entry (decision 13, role-based): no separate operator token —
 * the signed-in user's own token authorizes, and the server checks the admin
 * role on every call.
 */
export const AdminView = () => (
  <AdminHome api={createAdminApi(() => storedToken() ?? "")} />
);
