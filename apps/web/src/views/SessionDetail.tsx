import { useMemo, useState } from "react";
import type { TokenUsage } from "@slopwatch/events";
import type { CommentRow } from "../api";
import type { SessionSummary } from "../api";
import { useEventStream } from "../hooks/useEventStream";
import { useReview } from "../hooks/useReview";
import { sessionTotals } from "../lib/aggregate";
import { clock, fmtTokens } from "../lib/format";
import { buildTimeline, isEnded } from "../lib/timeline";
import { ConfirmButton, useAsyncAction } from "./admin-shared";
import { RawEventsView } from "./RawEventsView";
import { TurnsView } from "./TurnsView";
import { UsageView } from "./UsageView";

/**
 * "· summary cost: 237 in · 380 out · 1.1k reasoning" — the tokens the
 * displayed summary's LLM fold spent. Labeled so the numbers are never
 * mistaken for session usage (this spend happens outside the agent's key).
 * Absent on summaries folded before the field existed.
 */
const summaryUsageNote = (usage: TokenUsage): string => {
  const parts: string[] = [];
  if (usage.input_tokens !== undefined)
    parts.push(`${fmtTokens(usage.input_tokens)} in`);
  if (usage.output_tokens !== undefined)
    parts.push(`${fmtTokens(usage.output_tokens)} out`);
  if (usage.cache_read_tokens)
    parts.push(`${fmtTokens(usage.cache_read_tokens)} cache-read`);
  if (usage.reasoning_tokens)
    parts.push(`${fmtTokens(usage.reasoning_tokens)} reasoning`);
  return parts.length > 0 ? ` · summary cost: ${parts.join(" · ")}` : "";
};

type Tab = "turns" | "raw";

/** One review note line: who, where it points, what they said. */
const CommentLine = ({
  comment,
  mine,
  onDelete,
}: {
  comment: CommentRow;
  mine: boolean;
  onDelete: () => void;
}) => (
  <div className="comment">
    <span className="kind">{comment.turn_id ? "turn" : "session"}</span>
    <span className="detail">
      {comment.turn_id ? `on ${comment.turn_id} · ` : ""}
      {comment.body}
    </span>
    <span className="meta">
      {comment.author_id} · {clock(comment.created_at)}
      {mine && (
        <>
          {" · "}
          <ConfirmButton
            className="link"
            message="delete this note?"
            onClick={onDelete}
          >
            delete
          </ConfirmButton>
        </>
      )}
    </span>
  </div>
);

/** The selected session: identity facts, live state, and its activity. */
export const SessionDetail = ({ summary }: { summary: SessionSummary }) => {
  const stream = useEventStream(summary.session_id);
  const review = useReview(summary.session_id);
  const [tab, setTab] = useState<Tab>("turns");
  const [note, setNote] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const timeline = useMemo(() => buildTimeline(stream.events), [stream.events]);
  const start = timeline.starts.at(-1);
  const lastEnd = timeline.ends.at(-1);
  const ended = isEnded(timeline);
  const latestSummary = timeline.summaries.at(-1);
  // Event sums are the ground truth once loaded; the Server's token columns
  // undercount sessions that predate that migration.
  const totals = stream.events.length > 0 ? sessionTotals(stream.events) : null;

  const sessionComments = review.comments.filter((c) => c.turn_id === null);
  const run = useAsyncAction(setActionError);
  const addSessionNote = () => {
    if (!note.trim()) return;
    run(async () => {
      await review.api.addComment(summary.session_id, null, note.trim());
      setNote("");
      review.refresh();
    });
  };
  const deleteNote = (commentId: number) => {
    run(async () => {
      await review.api.deleteComment(summary.session_id, commentId);
      review.refresh();
    });
  };

  return (
    <div>
      <div className="sess-head">
        <h2 className="sess-title">{summary.title ?? "(untitled session)"}</h2>
        <span className={`chip ${ended ? "chip-down" : "chip-live"}`}>
          {ended ? `ended · ${lastEnd?.reason ?? "unknown"}` : "running"}
        </span>
        {stream.status === "down" && (
          <span className="chip chip-down">stream connection lost</span>
        )}
      </div>
      <div className="review-bar">
        <span className={`chip ${review.review ? "chip-live" : ""}`}>
          {review.review
            ? `Reviewed by ${review.review.reviewer_id} · ${clock(review.review.reviewed_at)}`
            : "Unreviewed"}
        </span>
        {review.me === null ? (
          <span className="dim">
            You can review and leave notes once your token verifies — reload the
            page to retry.
          </span>
        ) : review.me.is_dri ? (
          review.review ? (
            <button
              onClick={() =>
                run(async () => {
                  await review.api.unmarkReviewed(summary.session_id);
                  review.refresh();
                })
              }
            >
              Unmark reviewed
            </button>
          ) : (
            <button
              className="primary"
              onClick={() =>
                run(async () => {
                  await review.api.markReviewed(summary.session_id);
                  review.refresh();
                })
              }
            >
              Mark reviewed
            </button>
          )
        ) : null}
        {actionError && <span className="dim">{actionError}</span>}
      </div>
      <dl className="facts">
        <div>
          <dt>Session</dt>
          <dd className="mono">{summary.session_id}</dd>
        </div>
        <div>
          <dt>Agent</dt>
          <dd>{summary.agent}</dd>
        </div>
        <div>
          <dt>User</dt>
          <dd>{summary.user_id ?? "?"}</dd>
        </div>
        <div>
          <dt>First seen</dt>
          <dd className="mono">{clock(summary.first_seen_at)}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd className="mono">
            {totals
              ? `${fmtTokens(totals.inputTokens)} in · ${fmtTokens(totals.outputTokens)} out · ${fmtTokens(totals.cacheReadTokens)} cache-read`
              : `${fmtTokens(summary.total_input_tokens)} in · ${fmtTokens(summary.total_output_tokens)} out · ${fmtTokens(summary.total_cache_read_tokens)} cache-read`}
          </dd>
        </div>
        {start && (
          <div className="wide">
            <dt>Environment</dt>
            <dd>
              {start.hostname} · {start.cwd}
              {start.git_remote ? ` · ${start.git_remote}` : ""}
            </dd>
          </div>
        )}
        {summary.task_preview && (
          <div className="wide">
            <dt>Task</dt>
            <dd>{summary.task_preview}</dd>
          </div>
        )}
      </dl>
      {latestSummary && (
        <section className="machine-summary">
          <h3>
            Machine summary
            <span className="mono dim">· {latestSummary.model}</span>
            {latestSummary.usage && (
              <span className="mono dim">
                {summaryUsageNote(latestSummary.usage)}
              </span>
            )}
          </h3>
          <p>{latestSummary.body}</p>
          <p className="dim" style={{ fontSize: "11.5px" }}>
            Produced on the developer's machine with their own LLM key — a
            reading aid, never evidence; review the event stream.
          </p>
        </section>
      )}
      {totals && totals.requests > 0 && (
        <div className="panel-card">
          <div className="card-head">
            <h3 className="card-title">Usage</h3>
            <span className="dim" style={{ fontSize: "12px" }}>
              per-model request totals
            </span>
          </div>
          <UsageView events={stream.events} />
        </div>
      )}
      <nav className="segment">
        <button
          type="button"
          className={tab === "turns" ? "active" : ""}
          onClick={() => setTab("turns")}
        >
          Turns
          <span className="seg-count">{timeline.turns.length}</span>
        </button>
        <button
          type="button"
          className={tab === "raw" ? "active" : ""}
          onClick={() => setTab("raw")}
        >
          Raw events
          <span className="seg-count">{stream.events.length}</span>
        </button>
      </nav>
      {tab === "turns" ? (
        <TurnsView
          sessionId={summary.session_id}
          timeline={timeline}
          comments={review.comments}
          canComment={review.me !== null}
          currentUser={review.me?.user ?? null}
          sessionEnded={ended}
          onComment={(turnId, body) =>
            run(async () => {
              await review.api.addComment(summary.session_id, turnId, body);
              review.refresh();
            })
          }
          onDeleteComment={deleteNote}
        />
      ) : (
        <RawEventsView events={stream.events} />
      )}
      <section className="review-notes">
        <h3>Review notes</h3>
        {review.status === "down" && (
          <p className="dim">Notes unavailable · {review.lastError}</p>
        )}
        {sessionComments.length === 0 ? (
          <p className="dim">No session-level notes yet.</p>
        ) : (
          sessionComments.map((c) => (
            <CommentLine
              key={c.comment_id}
              comment={c}
              mine={review.me?.user === c.author_id}
              onDelete={() => deleteNote(c.comment_id)}
            />
          ))
        )}
        {review.me !== null ? (
          <form
            className="comment-form"
            onSubmit={(e) => {
              e.preventDefault();
              addSessionNote();
            }}
          >
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a session-level review note"
            />
            <button className="primary" type="submit">
              Add note
            </button>
          </form>
        ) : (
          <p className="dim">
            You can leave notes once your token verifies — reload the page to
            retry.
          </p>
        )}
      </section>
    </div>
  );
};
