import { useState } from "react";
import type { CommentRow } from "../api";
import type { SessionTimeline } from "../lib/timeline";
import {
  clock,
  fmtDuration,
  fmtTokens,
  shortId,
  summarizeArgs,
} from "../lib/format";

const usage = (inTokens?: number, outTokens?: number): string =>
  `${fmtTokens(inTokens ?? 0)}in/${fmtTokens(outTokens ?? 0)}out`;

type NoteInputProps = {
  placeholder: string;
  onComment: (body: string) => void;
};

/** Inline one-turn note composer: collapsed to a button until opened. */
const NoteInput = ({ placeholder, onComment }: NoteInputProps) => {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  if (!open)
    return (
      <button
        className="note-btn"
        onClick={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
      >
        note
      </button>
    );
  return (
    <form
      className="comment-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!body.trim()) return;
        onComment(body.trim());
        setBody("");
        setOpen(false);
      }}
    >
      <input
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        autoFocus
      />
      <button type="submit">add</button>
      <button type="button" onClick={() => setOpen(false)}>
        cancel
      </button>
    </form>
  );
};

type TurnCommentsProps = {
  comments: CommentRow[];
  currentUser?: string | null;
  onDelete?: (commentId: number) => void;
};

const TurnComments = ({
  comments,
  currentUser,
  onDelete,
}: TurnCommentsProps) => (
  <div className="comments">
    {comments.map((c) => (
      <div key={c.comment_id} className="comment">
        <span className="detail">{c.body}</span>
        <span className="meta">
          {c.author_id} · {clock(c.created_at)}
          {currentUser === c.author_id && onDelete && (
            <>
              {" · "}
              <button className="link" onClick={() => onDelete(c.comment_id)}>
                delete
              </button>
            </>
          )}
        </span>
      </div>
    ))}
  </div>
);

type TurnsViewProps = {
  timeline: SessionTimeline;
  comments?: CommentRow[];
  canComment?: boolean;
  onComment?: (turnId: string, body: string) => void;
  /** The signed-in user — only their own notes show the delete affordance. */
  currentUser?: string | null;
  onDeleteComment?: (commentId: number) => void;
  /** Ended sessions cannot produce more results: "running…" would be a lie. */
  sessionEnded?: boolean;
};

export const TurnsView = ({
  timeline,
  comments = [],
  canComment = false,
  onComment = () => {},
  currentUser = null,
  onDeleteComment,
  sessionEnded = false,
}: TurnsViewProps) => {
  const { turns, orphans } = timeline;
  if (
    turns.length === 0 &&
    orphans.requests.length === 0 &&
    orphans.tools.length === 0
  ) {
    return <p className="empty">no activity yet</p>;
  }
  return (
    <div className="turns">
      {turns.map((turn) => (
        <article key={turn.turnId} className="turn">
          <header className="turn-head">
            <span className={`kind ${turn.userMessage ? "accent" : ""}`}>
              turn {shortId(turn.turnId)}
            </span>
            <span className="meta">
              {turn.modelRequests.length} req · {turn.tools.length} tools
              {turn.usage
                ? ` · ${usage(turn.usage.input_tokens, turn.usage.output_tokens)}`
                : ""}
            </span>
            {canComment && (
              <NoteInput
                placeholder="review note for this turn"
                onComment={(body) => onComment(turn.turnId, body)}
              />
            )}
          </header>
          {turn.userMessage && (
            <blockquote className="user-msg">{turn.userMessage}</blockquote>
          )}
          <TurnComments
            comments={comments.filter((c) => c.turn_id === turn.turnId)}
            currentUser={currentUser}
            onDelete={onDeleteComment}
          />
          {turn.modelRequests.map((request, i) => (
            <div key={i} className="row">
              <span className="kind">request</span>
              <span className="detail">
                {request.provider}/{request.model} ·{" "}
                {fmtDuration(request.duration_ms)}
                {request.usage
                  ? ` · ${usage(request.usage.input_tokens, request.usage.output_tokens)}`
                  : ""}
              </span>
              <span className="meta">{clock(request.occurred_at)}</span>
            </div>
          ))}
          {turn.tools.map((tool, i) => (
            <div key={i} className="row">
              <span className="kind">tool</span>
              <span className="detail">
                {tool.call
                  ? `${tool.call.tool} · ${summarizeArgs(tool.call.args)}`
                  : "(result without call)"}
                {tool.result
                  ? tool.result.ok === false
                    ? ` · failed${tool.result.error ? `: ${tool.result.error}` : ""}`
                    : ` · ok${tool.result.duration_ms !== undefined ? ` · ${fmtDuration(tool.result.duration_ms)}` : ""}`
                  : sessionEnded
                    ? " · no result captured"
                    : " · running…"}
              </span>
            </div>
          ))}
          {turn.assistantMessage && (
            <blockquote className="assistant-msg">
              {turn.assistantMessage}
            </blockquote>
          )}
        </article>
      ))}
      {(orphans.requests.length > 0 || orphans.tools.length > 0) && (
        <article className="turn">
          <header className="turn-head">
            <span className="kind">unattributed</span>
            <span className="meta">
              events without a turn context (before the first request)
            </span>
          </header>
          {orphans.requests.map((request, i) => (
            <div key={i} className="row">
              <span className="kind">request</span>
              <span className="detail">
                {request.provider}/{request.model} ·{" "}
                {fmtDuration(request.duration_ms)}
              </span>
              <span className="meta">{clock(request.occurred_at)}</span>
            </div>
          ))}
          {orphans.tools.map((tool, i) => (
            <div key={i} className="row">
              <span className="kind">tool</span>
              <span className="detail">
                {tool.call
                  ? `${tool.call.tool} · ${summarizeArgs(tool.call.args)}`
                  : "(result without call)"}
              </span>
            </div>
          ))}
        </article>
      )}
    </div>
  );
};
