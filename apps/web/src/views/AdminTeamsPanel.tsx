import { useState } from "react";
import type { AdminApi, AdminTeamRow } from "../api";
import { clock, errorMessage } from "../lib/format";
import { usePolled, type PollError } from "./AdminView";

type Props = {
  api: AdminApi;
  refreshKey: number;
  refresh: () => void;
};

/**
 * Team management (v2 decision 23): create teams, set a per-team raw
 * retention override (decision 24), delete empty teams. Membership is
 * assigned per user in the users panel.
 */
export const AdminTeamsPanel = ({ api, refreshKey, refresh }: Props) => {
  const {
    data: teams,
    error,
  }: { data: AdminTeamRow[] | null; error: PollError | null } = usePolled(
    () => api.teams(),
    [refreshKey],
  );
  const [name, setName] = useState("");
  const [retention, setRetention] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setFormError(null);
    try {
      await fn();
      refresh();
    } catch (err) {
      setFormError(errorMessage(err));
    }
  };

  const addTeam = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const days = retention.trim() === "" ? null : Number(retention.trim());
    if (days !== null && (!Number.isInteger(days) || days < 1)) {
      setFormError("retention must be a positive whole number of days");
      return;
    }
    void run(async () => {
      await api.createTeam(name.trim(), days);
      setName("");
      setRetention("");
    });
  };

  return (
    <>
      <h2 className="page-title">Teams</h2>
      <p className="page-sub">
        Group members into teams for the leaderboard and per-team retention.
        Membership is assigned per user on the Users tab.
      </p>
      {error && <p className="banner-error">{error.message}</p>}
      <div className="panel-card">
        <form className="admin-form" onSubmit={addTeam}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="team name"
          />
          <input
            value={retention}
            onChange={(e) => setRetention(e.target.value)}
            placeholder="raw retention days (optional)"
          />
          <button className="primary" type="submit">
            Add team
          </button>
        </form>
        {formError && <p className="banner-error">{formError}</p>}
        <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Team</th>
                <th className="num">Members</th>
                <th title="Raw-payload retention override; empty = the global default">
                  Raw retention
                </th>
                <th>Created</th>
                <th className="actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(teams ?? []).map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td className="num">{t.member_count}</td>
                  <td className="num dim">
                    {t.raw_retention_days === null
                      ? "global default"
                      : `${t.raw_retention_days} days`}
                  </td>
                  <td className="mono">{clock(t.created_at)}</td>
                  <td className="actions">
                    <button
                      onClick={() =>
                        run(async () => {
                          const next = prompt(
                            `Raw retention days for "${t.name}" (empty = global default):`,
                            t.raw_retention_days?.toString() ?? "",
                          );
                          if (next === null) return;
                          await api.updateTeam(t.id, {
                            raw_retention_days:
                              next.trim() === "" ? null : Number(next.trim()),
                          });
                        })
                      }
                    >
                      Set retention
                    </button>
                    <button
                      className="danger"
                      onClick={() => {
                        if (
                          confirm(
                            `Delete team "${t.name}"? Members become unassigned; their captured sessions keep the historical team tag.`,
                          )
                        )
                          run(() => api.deleteTeam(t.id));
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {teams !== null && teams.length === 0 && (
          <p className="empty" style={{ marginTop: 12 }}>
            No teams yet — every user is unassigned.
          </p>
        )}
      </div>
    </>
  );
};
