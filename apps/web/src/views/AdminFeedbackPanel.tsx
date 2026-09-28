import { useEffect, useState } from "react";
import type { AdminApi, FeedbackAttachmentMeta, FeedbackRow } from "../api";
import { usePolled, type PollError } from "../hooks/usePolled";
import { feedbackAttachmentUrl } from "../lib/attachments";
import { FEEDBACK_KINDS, FEEDBACK_KIND_LABELS } from "../lib/feedback";
import { fmtBytes, fmtDate, shortId } from "../lib/format";
import {
  ConfirmButton,
  ErrorBanner,
  Pager,
  pageWindow,
  useAsyncAction,
} from "./admin-shared";
import { Select } from "./Select";

type Props = {
  api: AdminApi;
  refreshKey: number;
  refresh: () => void;
};

const PAGE_SIZE = 50;

const KIND_OPTIONS = [
  { value: "", label: "All kinds" },
  ...FEEDBACK_KINDS.map((kind) => ({
    value: kind,
    label: FEEDBACK_KIND_LABELS[kind],
  })),
];

/**
 * One attachment: images render as authed thumbnails (click for the full
 * bytes in a new tab), anything else is an authed link chip. The bytes ride
 * the admin plane, so the object URL carries the same bearer.
 */
const FeedbackAttachment = ({
  feedbackId,
  meta,
}: {
  feedbackId: number;
  meta: FeedbackAttachmentMeta;
}) => {
  const [url, setUrl] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    let alive = true;
    void feedbackAttachmentUrl(feedbackId, meta.sha256).then((loaded) => {
      if (!alive) return;
      if (loaded === null) setBroken(true);
      else setUrl(loaded);
    });
    return () => {
      alive = false;
    };
  }, [feedbackId, meta.sha256]);

  if (broken)
    return <span className="dim mono">({meta.filename} unavailable)</span>;
  if (url === null)
    return <span className="fb-thumb fb-thumb-pending" title={meta.filename} />;
  if (meta.mime.startsWith("image/"))
    return (
      <a href={url} target="_blank" rel="noreferrer" className="fb-thumb-link">
        <img className="fb-thumb" src={url} alt={meta.filename} />
      </a>
    );
  return (
    <a className="file-chip" href={url} target="_blank" rel="noreferrer">
      <span className="file-chip-name">{meta.filename}</span>
      <span className="dim">{fmtBytes(meta.size)}</span>
    </a>
  );
};

/**
 * The feedback reading surface (ADR 0009): what users filed, newest first,
 * filterable by kind. Stateless by design — the only actions are read and
 * delete.
 */
export const AdminFeedbackPanel = ({ api, refreshKey, refresh }: Props) => {
  const [kind, setKind] = useState("");
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const run = useAsyncAction(setActionError, refresh);

  const {
    data,
    error,
  }: {
    data: { rows: FeedbackRow[]; total: number } | null;
    error: PollError | null;
  } = usePolled(
    () =>
      api.feedback({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        kind: kind || undefined,
      }),
    [refreshKey, kind, page],
  );

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const { from, to } = pageWindow(total, page, PAGE_SIZE);

  return (
    <>
      <h2 className="page-title">Feedback</h2>
      <p className="page-sub">
        What users filed from the dashboard — defects they spotted while
        reviewing sessions, and feature suggestions. A signal channel, not a
        ticket queue: read it, act on it in ordinary conversation, delete what
        is noise.
      </p>
      <ErrorBanner message={actionError ?? error?.message ?? null} />
      <div className="panel-card">
        <form className="admin-form" onSubmit={(e) => e.preventDefault()}>
          <Select
            label="Filter feedback by kind"
            value={kind}
            onChange={(next) => {
              setKind(next);
              setPage(0);
            }}
            options={KIND_OPTIONS}
          />
        </form>
        <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>When</th>
                <th>From</th>
                <th>Kind</th>
                <th>Session</th>
                <th>Feedback</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.flatMap((row) => [
                <tr
                  key={row.feedback_id}
                  className="audit-row"
                  onClick={() =>
                    setOpenId(
                      openId === row.feedback_id ? null : row.feedback_id,
                    )
                  }
                >
                  <td className="mono">{fmtDate(row.created_at)}</td>
                  <td>{row.filer_id}</td>
                  <td>
                    <span className="tag tag-accent">
                      {FEEDBACK_KIND_LABELS[row.kind] ?? row.kind}
                    </span>
                  </td>
                  <td className="mono">
                    {row.session_id === null ? (
                      <span className="dim">—</span>
                    ) : (
                      <a href={`#/sessions/${row.session_id}`}>
                        {shortId(row.session_id)}
                      </a>
                    )}
                  </td>
                  <td className="dim">
                    {row.body.length > 80
                      ? `${row.body.slice(0, 79)}…`
                      : row.body}
                    {row.attachments.length > 0 &&
                      ` · ${row.attachments.length} file${row.attachments.length > 1 ? "s" : ""}`}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <ConfirmButton
                      className="link"
                      message={`delete this feedback (#${row.feedback_id} by ${row.filer_id})?`}
                      onClick={() =>
                        run(async () => {
                          await api.deleteFeedback(row.feedback_id);
                        })
                      }
                    >
                      delete
                    </ConfirmButton>
                  </td>
                </tr>,
                ...(openId === row.feedback_id
                  ? [
                      <tr
                        key={`${row.feedback_id}-detail`}
                        className="token-row"
                      >
                        <td colSpan={6}>
                          <div className="fb-detail">
                            <p className="fb-body">{row.body}</p>
                            {row.attachments.length > 0 && (
                              <div className="fb-attachments">
                                {row.attachments.map((meta) => (
                                  <FeedbackAttachment
                                    key={meta.sha256}
                                    feedbackId={row.feedback_id}
                                    meta={meta}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
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
          emptyLabel="No feedback"
        />
      </div>
      {data !== null && rows.length === 0 && (
        <p className="empty">
          Nothing filed yet — the Send feedback button in the header and on
          every session page files here.
        </p>
      )}
    </>
  );
};
