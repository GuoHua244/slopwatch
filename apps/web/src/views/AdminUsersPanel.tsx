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
import {
  ConfirmButton,
  ClipTip,
  ErrorBanner,
  useAsyncAction,
} from "./admin-shared";
import { Select } from "./Select";

type Props = {
  api: AdminApi;
  /** The signed-in admin — their own row blocks self role changes. */
  user: string;
  refreshKey: number;
  refresh: () => void;
};

export const AdminUsersPanel = ({ api, user, refreshKey, refresh }: Props) => {
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
  const [mintFor, setMintFor] = useState<string | null>(null);
  const [mintLabel, setMintLabel] = useState("");
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
    run(async () => {
      setMinted(await api.mintToken(u.name, mintLabel.trim() || null));
      setMintFor(null);
      if (openTokens[u.name])
        setOpenTokens({
          ...openTokens,
          [u.name]: await api.tokens(u.name),
        });
    });

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
            Token minted{minted.label ? ` (${minted.label})` : ""} — copy it
            now, it is shown once:
            <div className="secret">{minted.token}</div>
            <span className="dim">
              Hand it to the user: they sign in once on the sign-in page's "Use
              a token" door, then set their own password.
            </span>
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
                <th
                  className="num"
                  title="API access tokens minted for this user (not LLM usage)"
                >
                  API tokens
                </th>
                <th title="Whether the user can sign in with a user name and password (ADR 0011)">
                  Password
                </th>
                <th>Created</th>
                <th className="actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(users ?? []).flatMap((u) => [
                <tr key={u.name}>
                  <td>
                    <ClipTip label={u.name} className="cell-clip">
                      {u.name}
                    </ClipTip>
                  </td>
                  <td>
                    <ClipTip label={u.email} className="cell-clip wide">
                      {u.email ?? "—"}
                    </ClipTip>
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
                  <td>
                    {u.password_set ? (
                      <span className="tag tag-live">set</span>
                    ) : (
                      <span className="dim">token only</span>
                    )}
                  </td>
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
                      disabled={u.name === user}
                      title={
                        u.name === user
                          ? "You cannot change your own role — ask another admin or use the operator token."
                          : undefined
                      }
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
                    <button
                      onClick={() => {
                        setMintFor(u.name);
                        setMintLabel("");
                      }}
                    >
                      Mint token
                    </button>
                    <button onClick={() => void toggleTokens(u)}>
                      API tokens
                    </button>
                    {u.password_set && (
                      <ConfirmButton
                        className="danger"
                        message={`Clear ${u.name}'s password? They must sign in with a token once and set a new one.`}
                        onClick={() => run(() => api.clearPassword(u.name))}
                      >
                        Clear password
                      </ConfirmButton>
                    )}
                    <ConfirmButton
                      className="danger"
                      message={`Delete user "${u.name}" and all their tokens?`}
                      onClick={() => run(() => api.deleteUser(u.name))}
                    >
                      Delete
                    </ConfirmButton>
                  </td>
                </tr>,
                ...(mintFor === u.name
                  ? [
                      <tr key={`${u.name}-mint`} className="token-row">
                        <td colSpan={10}>
                          <form
                            className="admin-form"
                            onSubmit={(e) => {
                              e.preventDefault();
                              mintAndShow(u);
                            }}
                          >
                            <input
                              autoFocus
                              value={mintLabel}
                              maxLength={100}
                              onChange={(e) => setMintLabel(e.target.value)}
                              placeholder={`label for ${u.name}'s new token (optional)`}
                            />
                            <button className="primary" type="submit">
                              Mint
                            </button>
                            <button
                              type="button"
                              onClick={() => setMintFor(null)}
                            >
                              Cancel
                            </button>
                          </form>
                        </td>
                      </tr>,
                    ]
                  : []),
                ...(openTokens[u.name]
                  ? [
                      <tr key={`${u.name}-tokens`} className="token-row">
                        <td colSpan={10}>
                          {openTokens[u.name]!.length === 0
                            ? "No tokens minted yet."
                            : openTokens[u.name]!.map((t) => (
                                <div className="row" key={t.token_id}>
                                  <span className="kind">{t.hint}…</span>
                                  {t.label && (
                                    <ClipTip
                                      label={t.label}
                                      className="tag tag-dim token-label"
                                    >
                                      {t.label}
                                    </ClipTip>
                                  )}
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
