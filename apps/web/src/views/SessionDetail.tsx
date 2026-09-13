import { useMemo, useState } from "react";
import type { CommentRow } from "../api";
import type { SessionSummary } from "../api";
import { clearToken, saveToken, storedToken } from "../auth";
import { useEventStream } from "../hooks/useEventStream";
import { useReview } from "../hooks/useReview";
import { sessionTotals } from "../lib/aggregate";
import { clock, errorMessage, fmtTokens } from "../lib/format";
import { buildTimeline, isEnded } from "../lib/timeline";
import { RawEventsView } from "./RawEventsView";
import { TurnsView } from "./TurnsView";
import { UsageView } from "./UsageView";

type Tab = "turns" | "raw";

/** One review note line: who, where it points, what they said. */
const CommentLine = ({ comment }: { comment: CommentRow }) => (
  <div className="comment">
    <span className="kind">{comment.turn_id ? "turn" : "session"}</span>
    <span className="detail">
      {comment.turn_id ? `on ${comment.turn_id} · ` : ""}
      {comment.body}
    </span>
    <span className="meta">
      {comment.author_id} · {clock(comment.created_at)}
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
  const identify = () => {
    const token = prompt("Your Slopwatch user token (sw_…)");
    if (token && token.trim()) {
      saveToken(token.trim());
      review.refresh();
    }
  };
  const run = (fn: () => Promise<void>) => {
    setActionError(null);
    fn().catch((e: unknown) => setActionError(errorMessage(e)));
  };
  const addSessionNote = () => {
    if (!note.trim()) return;
    run(async () => {
      await review.api.addComment(summary.session_id, null, note.trim());
      setNote("");
      review.refresh();
    });
  };

  return (
    <div>
      <h2>{summary.title ?? "(untitled session)"}</h2>
      <p className={`state ${ended ? "down" : "live"}`}>
        {ended ? `ended · ${lastEnd?.reason ?? "unknown"}` : "running"}
        {stream.status === "down" ? " · stream connection lost" : ""}
      </p>
      <div className="review-bar">
        <span className={`state ${review.review ? "live" : ""}`}>
          {review.review
            ? `reviewed · ${review.review.reviewer_id} · ${clock(review.review.reviewed_at)}`
            : "unreviewed"}
        </span>
        {!storedToken() ? (
          <button onClick={identify}>identify to review…</button>
        ) : review.me === null ? (
          <button onClick={identify}>token rejected — retry…</button>
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
              unmark reviewed
            </button>
          ) : (
            <button
              onClick={() =>
                run(async () => {
                  await review.api.markReviewed(summary.session_id);
                  review.refresh();
                })
              }
            >
              mark reviewed
            </button>
          )
        ) : null}
        {review.me !== null && !review.me.is_dri && (
          <button
            className="link"
            onClick={() => {
              clearToken();
              review.refresh();
            }}
          >
            sign out ({review.me.user})
          </button>
        )}
        {actionError && <span className="meta">{actionError}</span>}
      </div>
      <dl className="facts">
        <div>
          <dt>session</dt>
          <dd className="mono">{summary.session_id}</dd>
        </div>
        <div>
          <dt>agent</dt>
          <dd>{summary.agent}</dd>
        </div>
        <div>
          <dt>user</dt>
          <dd>{summary.user_id ?? "?"}</dd>
        </div>
        <div>
          <dt>first seen</dt>
          <dd>{clock(summary.first_seen_at)}</dd>
        </div>
        <div>
          <dt>tokens</dt>
          <dd className="mono">
            {totals
              ? `${fmtTokens(totals.inputTokens)}in · ${fmtTokens(totals.outputTokens)}out · ${fmtTokens(totals.cacheReadTokens)}cache-read`
              : `${fmtTokens(summary.total_input_tokens)}in · ${fmtTokens(summary.total_output_tokens)}out · ${fmtTokens(summary.total_cache_read_tokens)}cache-read`}
          </dd>
        </div>
        {start && (
          <div>
            <dt>environment</dt>
            <dd>
              {start.hostname} · {start.cwd}
              {start.git_remote ? ` · ${start.git_remote}` : ""}
            </dd>
          </div>
        )}
        {summary.task_preview && (
          <div className="wide">
            <dt>task</dt>
            <dd>{summary.task_preview}</dd>
          </div>
        )}
      </dl>
      {latestSummary && (
        <section className="machine-summary">
          <h3>
            machine-generated summary{" "}
            <span className="meta">· {latestSummary.model}</span>
          </h3>
          <p>{latestSummary.body}</p>
          <p className="meta">
            produced on the developer's machine with their own LLM key — a
            reading aid, never evidence; review the event stream
          </p>
        </section>
      )}
      <UsageView events={stream.events} />
      <nav className="tabs">
        <button
          type="button"
          className={tab === "turns" ? "active" : ""}
          onClick={() => setTab("turns")}
        >
          turns ({timeline.turns.length})
        </button>
        <button
          type="button"
          className={tab === "raw" ? "active" : ""}
          onClick={() => setTab("raw")}
        >
          raw events ({stream.events.length})
        </button>
      </nav>
      {tab === "turns" ? (
        <TurnsView
          timeline={timeline}
          comments={review.comments}
          canComment={review.me !== null}
          onComment={(turnId, body) =>
            run(async () => {
              await review.api.addComment(summary.session_id, turnId, body);
              review.refresh();
            })
          }
        />
      ) : (
        <RawEventsView events={stream.events} />
      )}
      <section className="review-notes">
        <h3>review notes</h3>
        {review.status === "down" && (
          <p className="meta">notes unavailable · {review.lastError}</p>
        )}
        {sessionComments.length === 0 ? (
          <p className="empty">no session-level notes</p>
        ) : (
          sessionComments.map((c) => (
            <CommentLine key={c.comment_id} comment={c} />
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
              placeholder="add a session-level review note"
            />
            <button type="submit">add</button>
          </form>
        ) : (
          <p className="meta">identify above to leave review notes</p>
        )}
      </section>
    </div>
  );
};
