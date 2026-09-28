import { useState } from "react";
import type { AdminApi, AuditRow } from "../api";
import { usePolled, type PollError } from "../hooks/usePolled";
import { fmtDate, shortId } from "../lib/format";
import { ErrorBanner, Pager, pageWindow } from "./admin-shared";
import { Select } from "./Select";

type Props = {
  api: AdminApi;
  refreshKey: number;
  refresh: () => void;
};

const PAGE_SIZE = 50;

const CATEGORIES = [
  { value: "", label: "All categories" },
  { value: "user", label: "Users" },
  { value: "team", label: "Teams" },
  { value: "token", label: "Tokens" },
  { value: "settings", label: "Settings" },
  { value: "session", label: "Sessions" },
  { value: "review", label: "Reviews" },
  { value: "note", label: "Notes" },
  { value: "events", label: "System (prune)" },
];

/** Destructive verbs read red, additive ones green, the rest neutral. */
const tagClass = (action: string): string =>
  [".delete", ".revoke", ".unmark", ".prune"].some((suffix) =>
    action.endsWith(suffix),
  )
    ? "tag-down"
    : [".create", ".mint", ".mark", ".provision"].some((suffix) =>
          action.endsWith(suffix),
        )
      ? "tag-accent"
      : "tag-dim";

const clip = (s: string, max = 36): string =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

const valueText = (v: unknown): string => {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return clip(v) || '""';
  return clip(JSON.stringify(v) ?? "");
};

/** "role: member → admin · team: platform → —" from a diff detail. */
const changesText = (changes: unknown): string => {
  if (changes === null || typeof changes !== "object" || Array.isArray(changes))
    return "";
  return Object.entries(changes as Record<string, unknown>)
    .filter(
      ([, c]) =>
        c !== null &&
        typeof c === "object" &&
        "before" in (c as Record<string, unknown>) &&
        "after" in (c as Record<string, unknown>),
    )
    .map(([field, c]) => {
      const { before, after } = c as { before: unknown; after: unknown };
      return `${field}: ${valueText(before)} → ${valueText(after)}`;
    })
    .join(" · ");
};

/** The one-line human reading of an entry; blank when the columns say it all. */
const auditSummary = (row: AuditRow): string => {
  const d = row.detail ?? {};
  switch (row.action) {
    case "user.create":
      return d.email ? `email ${valueText(d.email)}` : "";
    case "user.update":
      return d.via === "boot"
        ? `admin role granted at boot`
        : changesText(d.changes);
    case "user.delete": {
      const bits = [
        d.role === undefined ? null : `role ${valueText(d.role)}`,
        d.team ? `team ${valueText(d.team)}` : null,
        d.email ? `email ${valueText(d.email)}` : null,
        d.active_tokens ? `${valueText(d.active_tokens)} tokens` : null,
      ].filter((x): x is string => x !== null);
      return bits.join(" · ");
    }
    case "user.provision":
      return `first appearance · via ${valueText(d.via)}`;
    case "team.create":
      return d.raw_retention_days === null || d.raw_retention_days === undefined
        ? ""
        : `retention ${valueText(d.raw_retention_days)}d`;
    case "team.update":
      return changesText(d.changes);
    case "team.delete":
      return d.member_count
        ? `${valueText(d.member_count)} members unassigned`
        : "no members";
    case "token.mint":
      return `hint ${valueText(d.hint)}…`;
    case "token.revoke":
      return [
        d.hint ? `hint ${valueText(d.hint)}…` : null,
        d.user ? `user ${valueText(d.user)}` : null,
      ]
        .filter((x): x is string => x !== null)
        .join(" · ");
    case "settings.update":
      return changesText(d.changes);
    case "session.delete": {
      const bits = [
        d.agent ? `agent ${valueText(d.agent)}` : null,
        d.user ? `user ${valueText(d.user)}` : null,
        d.events ? `${valueText(d.events)} events` : null,
      ].filter((x): x is string => x !== null);
      const title = d.title ? `"${clip(String(d.title), 48)}"` : null;
      return [title, ...bits]
        .filter((x): x is string => x !== null)
        .join(" · ");
    }
    case "note.add":
      return d.turn_id
        ? `on turn ${clip(String(d.turn_id), 20)}`
        : "session-level";
    case "note.delete":
      return d.body_preview
        ? `"${clip(String(d.body_preview), 60)}"`
        : `note #${valueText(d.comment_id)}`;
    case "events.prune":
      return `${valueText(d.pruned)} raw payloads nulled${
        d.archived ? ` · ${valueText(d.archived)} archived` : ""
      }`;
    default:
      return "";
  }
};

/** Session ids shrink like everywhere else; names and keys show verbatim. */
const targetDisplay = (target: string): string =>
  target.startsWith("sess_") && target.length > 20 ? shortId(target) : target;

export const AdminAuditPanel = ({ api, refreshKey }: Props) => {
  // The select applies instantly; the actor box commits on submit (Enter).
  const [kind, setKind] = useState("");
  const [actorInput, setActorInput] = useState("");
  const [actor, setActor] = useState("");
  const [page, setPage] = useState(0);
  const [openSeq, setOpenSeq] = useState<number | null>(null);

  const {
    data,
    error,
  }: {
    data: { rows: AuditRow[]; total: number } | null;
    error: PollError | null;
  } = usePolled(
    () =>
      api.audit({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        kind: kind || undefined,
        actor: actor || undefined,
      }),
    [refreshKey, kind, actor, page],
  );

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    setActor(actorInput.trim());
    setPage(0);
  };

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const { from, to } = pageWindow(total, page, PAGE_SIZE);

  return (
    <>
      <h2 className="page-title">Audit log</h2>
      <p className="page-sub">
        Append-only trail of every data change on the server — who acted, when,
        and what moved. Nothing here can be edited or deleted. Click a row for
        the raw record.
      </p>
      <ErrorBanner message={error?.message ?? null} />
      <div className="panel-card">
        <form className="admin-form" onSubmit={apply}>
          <Select
            label="Filter audit by category"
            value={kind}
            onChange={(next) => {
              setKind(next);
              setPage(0);
            }}
            options={CATEGORIES.map((c) => ({
              value: c.value,
              label: c.label,
            }))}
          />
          <input
            value={actorInput}
            onChange={(e) => setActorInput(e.target.value)}
            placeholder="actor — name, operator, or system"
          />
          <button className="primary" type="submit">
            Filter
          </button>
        </form>
        <div className="table-scroll">
          <table className="admin-table audit-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Target</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.flatMap((row) => [
                <tr
                  key={row.seq}
                  className="audit-row"
                  onClick={() =>
                    setOpenSeq(openSeq === row.seq ? null : row.seq)
                  }
                >
                  <td className="mono">{fmtDate(row.occurred_at)}</td>
                  <td>
                    {row.actor_kind === "user" ? (
                      (row.actor_user ?? "?")
                    ) : (
                      <span className="dim pseudo-actor">{row.actor_kind}</span>
                    )}
                  </td>
                  <td>
                    <span className={`tag ${tagClass(row.action)}`}>
                      <span className="mono">{row.action}</span>
                    </span>
                  </td>
                  <td className="mono">{targetDisplay(row.target)}</td>
                  <td className="dim">{auditSummary(row) || "—"}</td>
                </tr>,
                ...(openSeq === row.seq
                  ? [
                      <tr key={`${row.seq}-detail`} className="token-row">
                        <td colSpan={5}>
                          <pre className="audit-detail">
                            {JSON.stringify(row, null, 2)}
                          </pre>
                        </td>
                      </tr>,
                    ]
                  : []),
              ])}
            </tbody>
          </table>
        </div>
        <Pager
          page={page}
          setPage={setPage}
          total={total}
          from={from}
          to={to}
          emptyLabel="No entries"
        />
      </div>
      {data !== null && rows.length === 0 && (
        <p className="empty">
          No audit entries match — the server records every user, team, token,
          setting, session, review, and note change.
        </p>
      )}
    </>
  );
};
