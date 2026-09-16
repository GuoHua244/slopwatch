import { useState } from "react";
import type {
  AdminApi,
  AdminTeamRow,
  AdminTokenRow,
  AdminUserRow,
  MintedToken,
} from "../api";
import { usePolled, type PollError } from "../hooks/usePolled";
import { clock, errorMessage } from "../lib/format";
import { ConfirmButton, ErrorBanner, useAsyncAction } from "./admin-shared";
import { Select } from "./Select";

type Props = {
  api: AdminApi;
  refreshKey: number;
  refresh: () => void;
};

export const AdminUsersPanel = ({ api, refreshKey, refresh }: Props) => {
  const {
    data: users,
    error,
  }: { data: AdminUserRow[] | null; error: PollError | null } = usePolled(
    () => api.users(),
    [refreshKey],
  );
  const { data: teams }: { data: AdminTeamRow[] | null } = usePolled(
    () => api.teams(),
    [refreshKey],
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [minted, setMinted] = useState<MintedToken | null>(null);
  const [openTokens, setOpenTokens] = useState<Record<string, AdminTokenRow[]>>(
    {},
  );

  const run = useAsyncAction(setFormError, refresh);

  const addUser = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    void run(async () => {
      await api.createUser(name.trim(), email.trim() || null);
      setName("");
      setEmail("");
    });
  };

  const toggleTokens = async (u: AdminUserRow) => {
    if (openTokens[u.name]) {
      const next = { ...openTokens };
      delete next[u.name];
      setOpenTokens(next);
      return;
    }
    setFormError(null);
    try {
      setOpenTokens({ ...openTokens, [u.name]: await api.tokens(u.name) });
    } catch (err) {
      setFormError(errorMessage(err));
    }
  };

  const mintAndShow = (u: AdminUserRow) =>
    run(async () => setMinted(await api.mintToken(u.name)));

  const revoke = (u: AdminUserRow, t: AdminTokenRow) =>
    run(async () => {
      await api.revokeToken(t.token_id);
      setOpenTokens({ ...openTokens, [u.name]: await api.tokens(u.name) });
    });

  return (
    <>
      <h2 className="page-title">Users</h2>
      <p className="page-sub">
        Members, their roles, and their API tokens. Teams are assigned here.
      </p>
      <ErrorBanner message={error?.message ?? null} />
      <div className="panel-card">
        <form className="admin-form" onSubmit={addUser}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name"
          />
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email (optional)"
          />
          <button className="primary" type="submit">
            Add user
          </button>
        </form>
        {formError && <ErrorBanner message={formError} />}
        {minted && (
          <div className="token-reveal">
            Token minted — copy it now, it is shown once:
            <div className="secret">{minted.token}</div>
            <button onClick={() => setMinted(null)}>Hide</button>
          </div>
        )}
        <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Email</th>
                <th>Team</th>
                <th>Status</th>
                <th>Role</th>
                <th>DRI</th>
                <th className="num">Tokens</th>
                <th>Created</th>
                <th className="actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(users ?? []).flatMap((u) => [
                <tr key={u.name}>
                  <td>
                    <span className="cell-clip" title={u.name}>
                      {u.name}
                    </span>
                  </td>
                  <td>
                    <span
                      className="cell-clip wide"
                      title={u.email ?? undefined}
                    >
                      {u.email ?? "—"}
                    </span>
                  </td>
                  <td>
                    <Select
                      label={`Team for ${u.name}`}
                      value={u.team_id ?? ""}
                      onChange={(next) =>
                        run(() =>
                          api.setUserTeam(u.name, next === "" ? null : next),
                        )
                      }
                      options={[
                        { value: "", label: "unassigned" },
                        ...(teams ?? []).map((t) => ({
                          value: t.id,
                          label: t.name,
                        })),
                      ]}
                    />
                  </td>
                  <td>
                    <span
                      className={`tag ${u.disabled ? "tag-down" : "tag-live"}`}
                    >
                      {u.disabled ? "disabled" : "active"}
                    </span>
                  </td>
                  <td>
                    {u.role === "admin" ? (
                      <span className="tag tag-accent">admin</span>
                    ) : (
                      <span className="dim">member</span>
                    )}
                  </td>
                  <td>
                    {u.is_dri ? <span className="tag tag-dim">dri</span> : "—"}
                  </td>
                  <td className="num">{u.active_tokens}</td>
                  <td className="mono">{clock(u.created_at)}</td>
                  <td className="actions">
                    <button
                      onClick={() =>
                        run(() => api.setUserDisabled(u.name, !u.disabled))
                      }
                    >
                      {u.disabled ? "Enable" : "Disable"}
                    </button>
                    <button
                      onClick={() =>
                        run(() =>
                          api.setUserRole(
                            u.name,
                            u.role === "admin" ? "member" : "admin",
                          ),
                        )
                      }
                    >
                      {u.role === "admin" ? "Demote" : "Make admin"}
                    </button>
                    <button
                      onClick={() =>
                        run(() => api.setUserDri(u.name, !u.is_dri))
                      }
                    >
                      {u.is_dri ? "Unset DRI" : "Make DRI"}
                    </button>
                    <button onClick={() => mintAndShow(u)}>Mint token</button>
                    <button onClick={() => void toggleTokens(u)}>Tokens</button>
                    <ConfirmButton
                      className="danger"
                      message={`Delete user "${u.name}" and all their tokens?`}
                      onClick={() => run(() => api.deleteUser(u.name))}
                    >
                      Delete
                    </ConfirmButton>
                  </td>
                </tr>,
                ...(openTokens[u.name]
                  ? [
                      <tr key={`${u.name}-tokens`} className="token-row">
                        <td colSpan={9}>
                          {openTokens[u.name]!.length === 0
                            ? "No tokens minted yet."
                            : openTokens[u.name]!.map((t) => (
                                <div className="row" key={t.token_id}>
                                  <span className="kind">{t.hint}…</span>
                                  <span className="detail">
                                    created {clock(t.created_at)}
                                    {t.revoked_at
                                      ? ` · revoked ${clock(t.revoked_at)}`
                                      : ""}
                                  </span>
                                  {!t.revoked_at && (
                                    <button
                                      className="danger"
                                      onClick={() => revoke(u, t)}
                                    >
                                      Revoke
                                    </button>
                                  )}
                                </div>
                              ))}
                        </td>
                      </tr>,
                    ]
                  : []),
              ])}
            </tbody>
          </table>
        </div>
      </div>
      {users !== null && users.length === 0 && (
        <p className="empty">No users yet — add the first one above.</p>
      )}
    </>
  );
};
