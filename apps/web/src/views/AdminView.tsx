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
import { AdminAuditPanel } from "./AdminAuditPanel";
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
 * visible, never overlap, survive errors). The effect re-arms whenever a
 * dependency changes — panels pass [refreshKey] so mutations surface
 * immediately; the audit panel adds its filter/page state.
 */
export const usePolled = <T,>(
  fetcher: () => Promise<T>,
  deps: React.DependencyList,
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
    // fetcher closes over the current api/token; deps mark changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
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
    <h2 className="page-title">System health</h2>
    <p className="page-sub">
      Capture pipeline at a glance — counts, freshness, and what the listeners
      could not parse.
    </p>
    {health.error && <p className="banner-error">{health.error.message}</p>}
    {health.data && (
      <div className="kpi-row">
        <div className="kpi-card">
          <div className="kpi-value live">{health.data.sessions}</div>
          <div className="kpi-label">Sessions</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-value">{health.data.events}</div>
          <div className="kpi-label">Events captured</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-value">
            {health.data.last_event_at ? clock(health.data.last_event_at) : "—"}
          </div>
          <div className="kpi-label">Last event received</div>
        </div>
        <div className="kpi-card">
          <div
            className={`kpi-value ${health.data.quarantine_24h > 0 ? "down" : "live"}`}
          >
            {health.data.quarantine_24h}
          </div>
          <div className="kpi-label">
            Quarantined (24h of {health.data.quarantine_total})
          </div>
        </div>
      </div>
    )}
    <div className="panel-card">
      <div className="card-head">
        <h3 className="card-title">Recent quarantined lines</h3>
        <span className="settings-status off">schema drift</span>
      </div>
      <p className="card-lede">
        Listener lines that could not be normalized. A nonzero count means an
        agent wrote something the adapter does not know yet — capture otherwise
        continues.
      </p>
      {quarantine.error && (
        <p className="banner-error">{quarantine.error.message}</p>
      )}
      {quarantine.data !== null &&
        (quarantine.data.length === 0 ? (
          <p className="dim">Nothing quarantined — capture is clean.</p>
        ) : (
          <div className="table-scroll" style={{ marginTop: 12 }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Agent</th>
                  <th>Reason</th>
                  <th>Line (capped)</th>
                </tr>
              </thead>
              <tbody>
                {quarantine.data.map((row) => (
                  <tr key={row.seq}>
                    <td className="mono" style={{ whiteSpace: "nowrap" }}>
                      {clock(row.created_at)}
                    </td>
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
          </div>
        ))}
    </div>
  </>
);

type AdminTab =
  | "users"
  | "teams"
  | "sessions"
  | "settings"
  | "audit"
  | "health";

const AdminHome = ({ api }: { api: AdminApi }) => {
  const [tab, setTab] = useState<AdminTab>("users");
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey((k) => k + 1);
  const health = usePolled(() => api.health(), [refreshKey]);
  const quarantine = usePolled(() => api.quarantine(50), [refreshKey]);

  // A revoked token or a role pulled mid-session shows as one honest banner
  // instead of five panels each 401/403-ing.
  const gate =
    health.error?.status === 401
      ? "your user token is no longer valid — sign in again from the me page"
      : health.error?.status === 403
        ? "the admin role is required for this area"
        : null;

  return (
    <div>
      <nav className="tabs">
        <button
          className={tab === "users" ? "active" : ""}
          onClick={() => setTab("users")}
        >
          Users
        </button>
        <button
          className={tab === "teams" ? "active" : ""}
          onClick={() => setTab("teams")}
        >
          Teams
        </button>
        <button
          className={tab === "sessions" ? "active" : ""}
          onClick={() => setTab("sessions")}
        >
          Sessions
        </button>
        <button
          className={tab === "settings" ? "active" : ""}
          onClick={() => setTab("settings")}
        >
          Settings
        </button>
        <button
          className={tab === "audit" ? "active" : ""}
          onClick={() => setTab("audit")}
        >
          Audit
        </button>
        <button
          className={tab === "health" ? "active" : ""}
          onClick={() => setTab("health")}
        >
          Health
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
      ) : tab === "audit" ? (
        <AdminAuditPanel api={api} refreshKey={refreshKey} refresh={refresh} />
      ) : (
        <HealthPanel health={health} quarantine={quarantine} />
      )}
    </div>
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
