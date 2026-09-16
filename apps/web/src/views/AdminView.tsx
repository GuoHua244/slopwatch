import { useMemo, useState } from "react";
import {
  createAdminApi,
  type AdminApi,
  type AdminHealth,
  type QuarantineRow,
} from "../api";
import { storedToken } from "../auth";
import { usePolled, type PollError } from "../hooks/usePolled";
import { clock } from "../lib/format";
import { AdminAuditPanel } from "./AdminAuditPanel";
import { AdminSessionsPanel } from "./AdminSessionsPanel";
import { AdminSettingsPanel } from "./AdminSettingsPanel";
import { AdminTeamsPanel } from "./AdminTeamsPanel";
import { AdminUsersPanel } from "./AdminUsersPanel";

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
 * role on every call. The client is memoized: rebuilding it per render would
 * hand every panel's usePolled a fresh fetcher identity.
 */
export const AdminView = () => {
  const api = useMemo(() => createAdminApi(() => storedToken() ?? ""), []);
  return <AdminHome api={api} />;
};
