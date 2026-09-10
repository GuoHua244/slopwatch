import { useState } from "react";
import { createApi, type AdminApi, type SessionSummary } from "../api";
import { clock, fmtTokens, shortId } from "../lib/format";
import { usePolled, type PollError } from "./AdminView";

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const readApi = createApi();

type Props = {
  api: AdminApi;
  refreshKey: number;
  refresh: () => void;
};

/**
 * The incident-remediation view (decision 13): every org-visible session
 * with a destructive delete for when someone pasted a secret into a prompt.
 */
export const AdminSessionsPanel = ({ api, refreshKey, refresh }: Props) => {
  const {
    data: sessions,
    error,
  }: {
    data: SessionSummary[] | null;
    error: PollError | null;
  } = usePolled(() => readApi.listSessions(), refreshKey);
  const [actionError, setActionError] = useState<string | null>(null);

  const remove = (s: SessionSummary) => {
    if (
      !confirm(
        `Delete session ${shortId(s.session_id)} ("${s.title ?? "untitled"}") and all its events? This cannot be undone.`,
      )
    )
      return;
    setActionError(null);
    api
      .deleteSession(s.session_id)
      .then(refresh)
      .catch((e) => setActionError(errorMessage(e)));
  };

  return (
    <>
      <h2>sessions</h2>
      {error && <p className="banner-error">{error.message}</p>}
      {actionError && <p className="banner-error">{actionError}</p>}
      <table className="admin-table">
        <thead>
          <tr>
            <th>session</th>
            <th>title</th>
            <th>user</th>
            <th>agent</th>
            <th>events</th>
            <th>in/out</th>
            <th>first seen</th>
            <th>actions</th>
          </tr>
        </thead>
        <tbody>
          {(sessions ?? []).map((s) => (
            <tr key={s.session_id}>
              <td>{shortId(s.session_id)}</td>
              <td>
                <a href={`#/sessions/${encodeURIComponent(s.session_id)}`}>
                  {s.title ?? "(untitled)"}
                </a>
              </td>
              <td>{s.user_id ?? "?"}</td>
              <td>{s.agent}</td>
              <td className="num">{s.last_seq}</td>
              <td className="num">
                {fmtTokens(s.total_input_tokens)}/
                {fmtTokens(s.total_output_tokens)}
              </td>
              <td>{clock(s.first_seen_at)}</td>
              <td className="actions">
                <button className="danger" onClick={() => remove(s)}>
                  delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {sessions !== null && sessions.length === 0 && (
        <p className="empty">no sessions captured yet</p>
      )}
    </>
  );
};
