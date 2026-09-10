import { useState } from "react";
import type {
  AdminApi,
  AdminTokenRow,
  AdminUserRow,
  MintedToken,
} from "../api";
import { clock } from "../lib/format";
import { usePolled, type PollError } from "./AdminView";

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

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
    refreshKey,
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [minted, setMinted] = useState<MintedToken | null>(null);
  const [openTokens, setOpenTokens] = useState<Record<string, AdminTokenRow[]>>(
    {},
  );

  const run = async (fn: () => Promise<void>) => {
    setFormError(null);
    try {
      await fn();
      refresh();
    } catch (err) {
      setFormError(errorMessage(err));
    }
  };

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
      <h2>users</h2>
      {error && <p className="banner-error">{error.message}</p>}
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
        <button type="submit">add user</button>
      </form>
      {formError && <p className="banner-error">{formError}</p>}
      {minted && (
        <div className="token-reveal">
          token minted — copy it now, it is shown once:
          <div className="secret">{minted.token}</div>
        </div>
      )}
      <table className="admin-table">
        <thead>
          <tr>
            <th>user</th>
            <th>email</th>
            <th>status</th>
            <th>role</th>
            <th>tokens</th>
            <th>created</th>
            <th>actions</th>
          </tr>
        </thead>
        <tbody>
          {(users ?? []).flatMap((u) => [
            <tr key={u.name}>
              <td>{u.name}</td>
              <td>{u.email ?? "—"}</td>
              <td className={u.disabled ? "cell-down" : "cell-live"}>
                {u.disabled ? "disabled" : "active"}
              </td>
              <td>{u.is_dri ? "dri" : "—"}</td>
              <td className="num">{u.active_tokens}</td>
              <td>{clock(u.created_at)}</td>
              <td className="actions">
                <button
                  onClick={() =>
                    run(() => api.setUserDisabled(u.name, !u.disabled))
                  }
                >
                  {u.disabled ? "enable" : "disable"}
                </button>
                <button
                  onClick={() => run(() => api.setUserDri(u.name, !u.is_dri))}
                >
                  {u.is_dri ? "unset dri" : "make dri"}
                </button>
                <button onClick={() => mintAndShow(u)}>mint token</button>
                <button onClick={() => void toggleTokens(u)}>tokens</button>
                <button
                  className="danger"
                  onClick={() => {
                    if (
                      confirm(`Delete user "${u.name}" and all their tokens?`)
                    )
                      run(() => api.deleteUser(u.name));
                  }}
                >
                  delete
                </button>
              </td>
            </tr>,
            ...(openTokens[u.name]
              ? [
                  <tr key={`${u.name}-tokens`} className="token-row">
                    <td colSpan={6}>
                      {openTokens[u.name]!.length === 0
                        ? "no tokens minted"
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
                                  revoke
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
      {users !== null && users.length === 0 && (
        <p className="empty">no users yet — add the first one above</p>
      )}
    </>
  );
};
