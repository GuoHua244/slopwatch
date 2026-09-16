import { useMemo, useState } from "react";
import { createApi, type AdminApi, type SessionSummary } from "../api";
import { usePolled, type PollError } from "../hooks/usePolled";
import { clock, fmtTokens, shortId, sinceDuration } from "../lib/format";
import { ConfirmButton, ErrorBanner, useAsyncAction } from "./admin-shared";

const readApi = createApi();

type Props = {
  api: AdminApi;
  refreshKey: number;
  refresh: () => void;
};

type UserGroup = {
  userId: string;
  sessions: SessionSummary[];
  totalIn: number;
  totalOut: number;
  lastActive: string | null;
};

/** Group the org's sessions per member so a lead triages one person at a time. */
const groupByUser = (sessions: SessionSummary[]): UserGroup[] => {
  const groups = new Map<string, UserGroup>();
  for (const s of sessions) {
    const userId = s.user_id ?? "(unknown)";
    let group = groups.get(userId);
    if (!group) {
      group = {
        userId,
        sessions: [],
        totalIn: 0,
        totalOut: 0,
        lastActive: null,
      };
      groups.set(userId, group);
    }
    group.sessions.push(s);
    group.totalIn += s.total_input_tokens;
    group.totalOut += s.total_output_tokens;
    const last = s.last_event_at ?? s.first_seen_at;
    if (group.lastActive === null || last > group.lastActive)
      group.lastActive = last;
  }
  return [...groups.values()].sort((a, b) =>
    (b.lastActive ?? "").localeCompare(a.lastActive ?? ""),
  );
};

/**
 * The incident-remediation view (decision 13), grouped per member: the lead
 * sees each person's sessions and footprint, and can delete any session
 * (e.g. when someone pasted a secret into a prompt). Groups collapse.
 */
export const AdminSessionsPanel = ({ api, refreshKey, refresh }: Props) => {
  const {
    data: sessions,
    error,
  }: {
    data: SessionSummary[] | null;
    error: PollError | null;
  } = usePolled(() => readApi.listSessions(), [refreshKey]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => groupByUser(sessions ?? []), [sessions]);

  const run = useAsyncAction(setActionError, refresh);

  const remove = (s: SessionSummary) =>
    run(async () => {
      await api.deleteSession(s.session_id);
    });

  return (
    <>
      <h2 className="page-title">Sessions</h2>
      <p className="page-sub">
        Every org-visible session, grouped by member. Deleting is for incident
        remediation — it cannot be undone.
      </p>
      <ErrorBanner message={error?.message ?? null} />
      <ErrorBanner message={actionError} />
      {/* A handful of members reads better expanded; a big roster defaults to
          collapsed groups so the 5s poll does not re-diff hundreds of rows. */}
      {groups.map((group) => {
        const isOpen =
          groups.length <= 8
            ? !collapsed[group.userId]
            : collapsed[group.userId] === false;
        return (
          <div key={group.userId} className={`group${isOpen ? " open" : ""}`}>
            <button
              type="button"
              className="group-head"
              aria-expanded={isOpen}
              onClick={() =>
                setCollapsed((prev) => ({
                  ...prev,
                  // store the PREVIOUS open state: both read paths derive
                  // "open" from collapsed[u] (≤8 groups: !collapsed[u];
                  // >8: collapsed[u] === false), so writing the negation
                  // made every click a no-op
                  [group.userId]: isOpen,
                }))
              }
            >
              <span className="group-caret">
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 8 8"
                  fill="none"
                  aria-hidden
                >
                  <path
                    d="M2.5 1l3 3-3 3"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span className="group-avatar">
                {group.userId.slice(0, 1).toUpperCase()}
              </span>
              {group.userId}
              <span className="group-meta">
                <span>
                  {group.sessions.length}{" "}
                  {group.sessions.length === 1 ? "session" : "sessions"}
                </span>
                <span>
                  {fmtTokens(group.totalIn)} / {fmtTokens(group.totalOut)}{" "}
                  in-out
                </span>
                <span>
                  active{" "}
                  {group.lastActive ? sinceDuration(group.lastActive) : "—"} ago
                </span>
              </span>
            </button>
            {isOpen && (
              <div className="group-body">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Session</th>
                      <th>Title</th>
                      <th>Agent</th>
                      <th className="num">Events</th>
                      <th className="num">In / out</th>
                      <th>Last event</th>
                      <th className="actions">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...group.sessions]
                      .sort((a, b) =>
                        (b.last_event_at ?? b.first_seen_at).localeCompare(
                          a.last_event_at ?? a.first_seen_at,
                        ),
                      )
                      .map((s) => (
                        <tr key={s.session_id}>
                          <td className="mono">{shortId(s.session_id)}</td>
                          <td>
                            <span className="cell-clamp">
                              <a
                                href={`#/sessions/${encodeURIComponent(s.session_id)}`}
                              >
                                {s.title ?? s.task_preview ?? "(untitled)"}
                              </a>
                            </span>
                          </td>
                          <td>{s.agent}</td>
                          <td className="num">{s.last_seq}</td>
                          <td className="num">
                            {fmtTokens(s.total_input_tokens)} /{" "}
                            {fmtTokens(s.total_output_tokens)}
                          </td>
                          <td className="dim" style={{ whiteSpace: "nowrap" }}>
                            {s.last_event_at ? clock(s.last_event_at) : "—"}
                          </td>
                          <td className="actions">
                            <ConfirmButton
                              className="danger"
                              message={`Delete session ${shortId(s.session_id)} ("${s.title ?? "untitled"}") and all its events? This cannot be undone.`}
                              onClick={() => remove(s)}
                            >
                              Delete
                            </ConfirmButton>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
      {sessions !== null && sessions.length === 0 && (
        <p className="empty">No sessions captured yet.</p>
      )}
    </>
  );
};
