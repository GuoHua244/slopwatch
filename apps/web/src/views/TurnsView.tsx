import { useEffect, useState, type ReactNode } from "react";
import type {
  ModelRequestEvent,
  TurnFileRef,
  TurnImageRef,
} from "@slopwatch/events";
import type { CommentRow } from "../api";
import { attachmentUrl } from "../lib/attachments";
import type { SessionTimeline, ToolActivity } from "../lib/timeline";
import {
  clock,
  fmtBytes,
  fmtDuration,
  fmtTokens,
  shortId,
  summarizeArgs,
} from "../lib/format";

const usage = (
  inTokens?: number,
  outTokens?: number,
  cacheReadTokens = 0,
): string =>
  `${fmtTokens(inTokens ?? 0)}in/${fmtTokens(outTokens ?? 0)}out${
    cacheReadTokens > 0 ? `/${fmtTokens(cacheReadTokens)}crd` : ""
  }`;

/** Stable React keys: the listener's request id when present, else the
 * request's own time+duration (stable for the append-only stream). */
const requestKey = (request: ModelRequestEvent): string =>
  request.request_id ?? `${request.occurred_at}-${request.duration_ms}`;

/** A tool row is identified by the call/result pairing id. */
const toolKey = (tool: ToolActivity, index: number): string =>
  tool.call?.tool_call_id ?? tool.result?.tool_call_id ?? String(index);

/** Click-to-zoom overlay: the full captured image over a dimmed page. */
const Lightbox = ({
  src,
  title,
  onClose,
}: {
  src: string;
  title: string;
  onClose: () => void;
}) => (
  <div className="lightbox" onClick={onClose} title="click to close">
    <img src={src} alt={title} />
  </div>
);

/** One captured image: fetches its (immutable) bytes via the authed loader
 * and shows a thumbnail; a failed load means the image never made it. */
const TurnImage = ({
  sessionId,
  sha256,
  label,
  onOpen,
}: {
  sessionId: string;
  sha256: string;
  label: string;
  onOpen: (src: string, title: string) => void;
}) => {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void attachmentUrl(sessionId, sha256).then((url) => {
      if (alive) setSrc(url);
    });
    return () => {
      alive = false;
    };
  }, [sessionId, sha256]);
  if (src === null)
    return (
      <span className="msg-img missing" title={`image not archived (${label})`}>
        ▲?
      </span>
    );
  return (
    <img
      className="msg-img"
      src={src}
      alt={label}
      title={label}
      loading="lazy"
      onClick={() => onOpen(src, label)}
    />
  );
};

/** A doc-glyph SVG for file chips (shape varies by mime family). */
const FileGlyph = ({ mime }: { mime: string }) => {
  const path = mime.startsWith("video/")
    ? "M2 2.5h6.5v7H2zM8.5 5l1.8-1.4v4.8L8.5 7z" // play-in-frame
    : mime.startsWith("audio/")
      ? "M3 2h4v6H3zM7 3a2.4 2.4 0 1 1 0 4" // note
      : "M2.5 1.5h4l3 3v6h-7zM6.5 1.5v3h3"; // document with folded corner
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d={path}
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
};

/** One captured file: an authed link to its (immutable) bytes — PDFs and
 * videos open in a new tab, everything else downloads. A failed load means
 * the file never made it to the server. */
const TurnFile = ({
  sessionId,
  file,
}: {
  sessionId: string;
  file: TurnFileRef;
}) => {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void attachmentUrl(sessionId, file.sha256).then((url) => {
      if (alive) setSrc(url);
    });
    return () => {
      alive = false;
    };
  }, [sessionId, file.sha256]);
  const label = `${file.name} · ${fmtBytes(file.size)}`;
  if (src === null)
    return (
      <span
        className="file-chip missing"
        title={`file not archived (${file.name})`}
      >
        <FileGlyph mime={file.mime} />
        ▦?
      </span>
    );
  return (
    <a
      className="file-chip"
      href={src}
      target="_blank"
      rel="noreferrer"
      title={label}
    >
      <FileGlyph mime={file.mime} />
      <span className="file-chip-name">{file.name}</span>
      <span className="file-chip-size">{fmtBytes(file.size)}</span>
    </a>
  );
};

const markerPattern =
  /\[image #(\d+)\]|\[file #(\d+)\]|\[Image: source: ([^\]]+)\]/g;

/** The user's words with their images and files: `[image #n]` markers become
 * thumbnails, `[file #n]` markers become file chips, legacy
 * `[Image: source: <path>]` leftovers (cache pruned before capture shipped)
 * render as a dim not-archived chip. Refs the text never mentions —
 * image-only or file-only inputs — append as trailing strips. */
const UserMessageContent = ({
  sessionId,
  text,
  images,
  files,
  onOpen,
}: {
  sessionId: string;
  text: string;
  images?: TurnImageRef[];
  files?: TurnFileRef[];
  onOpen: (src: string, title: string) => void;
}) => {
  const refFor = (n: number): TurnImageRef | undefined =>
    images?.find((img) => img.n === n);
  const fileRefFor = (n: number): TurnFileRef | undefined =>
    files?.find((file) => file.n === n);
  const referenced = new Set<number>();
  const referencedFiles = new Set<number>();
  const parts: ReactNode[] = [];
  let cursor = 0;
  const pushImage = (ref: TurnImageRef, key: string) => {
    parts.push(
      <TurnImage
        key={key}
        sessionId={sessionId}
        sha256={ref.sha256}
        label={`image #${ref.n}`}
        onOpen={onOpen}
      />,
    );
  };
  const scan = (pattern: RegExp, handle: (m: RegExpExecArray) => void) => {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
      parts.push(text.slice(cursor, m.index));
      handle(m);
      cursor = m.index + m[0].length;
    }
  };
  // One combined pass in text order — sequential per-pattern passes sharing
  // this cursor would re-emit text whenever a later pattern matches earlier
  // in the string (a file and an image in one message is the normal case).
  scan(markerPattern, (m) => {
    if (m[1] !== undefined) {
      const n = Number(m[1]);
      const ref = refFor(n);
      referenced.add(n);
      if (ref) pushImage(ref, `img-${ref.sha256}-${n}`);
      else parts.push(m[0]);
      return;
    }
    if (m[2] !== undefined) {
      const n = Number(m[2]);
      const ref = fileRefFor(n);
      referencedFiles.add(n);
      if (ref)
        parts.push(
          <TurnFile
            key={`file-${ref.sha256}-${n}`}
            sessionId={sessionId}
            file={ref}
          />,
        );
      else parts.push(m[0]);
      return;
    }
    parts.push(
      <span key={`gone-${m.index}`} className="msg-img-gone" title={m[3]!}>
        {`[image not archived]`}
      </span>,
    );
  });
  parts.push(text.slice(cursor));
  const stripped = (images ?? []).filter((img) => !referenced.has(img.n));
  if (stripped.length > 0)
    parts.push(
      <span key="strip" className="msg-img-strip">
        {stripped.map((ref) => (
          <TurnImage
            key={`strip-${ref.sha256}`}
            sessionId={sessionId}
            sha256={ref.sha256}
            label={`image #${ref.n}`}
            onOpen={onOpen}
          />
        ))}
      </span>,
    );
  const strippedFiles = (files ?? []).filter(
    (file) => !referencedFiles.has(file.n),
  );
  if (strippedFiles.length > 0)
    parts.push(
      <span key="file-strip" className="msg-file-strip">
        {strippedFiles.map((ref) => (
          <TurnFile
            key={`file-strip-${ref.sha256}`}
            sessionId={sessionId}
            file={ref}
          />
        ))}
      </span>,
    );
  return <>{parts}</>;
};

/** Screenshots a tool returned, shown as thumbnails on the tool's row. */
const ToolImages = ({
  sessionId,
  shas,
  onOpen,
}: {
  sessionId: string;
  shas: string[];
  onOpen: (src: string, title: string) => void;
}) => (
  <span className="msg-img-strip">
    {shas.map((sha) => (
      <TurnImage
        key={sha}
        sessionId={sessionId}
        sha256={sha}
        label={`tool image ${sha.slice(0, 8)}`}
        onOpen={onOpen}
      />
    ))}
  </span>
);

type NoteInputProps = {
  placeholder: string;
  onComment: (body: string) => void;
}; /** Inline one-turn note composer: collapsed to a button until opened. */
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
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
          <path
            d="M5 1.2v7.6M1.2 5h7.6"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
        Note
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
  /** The session the timeline belongs to — attachment fetches are per-session. */
  sessionId: string;
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
  sessionId,
  timeline,
  comments = [],
  canComment = false,
  onComment = () => {},
  currentUser = null,
  onDeleteComment,
  sessionEnded = false,
}: TurnsViewProps) => {
  const { turns, orphans } = timeline;
  const [lightbox, setLightbox] = useState<{
    src: string;
    title: string;
  } | null>(null);
  const openImage = (src: string, title: string) => setLightbox({ src, title });
  if (
    turns.length === 0 &&
    orphans.requests.length === 0 &&
    orphans.tools.length === 0
  ) {
    return <p className="empty">no activity yet</p>;
  }
  return (
    <div className="turns">
      {lightbox !== null && (
        <Lightbox
          src={lightbox.src}
          title={lightbox.title}
          onClose={() => setLightbox(null)}
        />
      )}
      {turns.map((turn) => (
        <article key={turn.turnId} className="turn">
          <header className="turn-head">
            <span className="turn-id">{shortId(turn.turnId)}</span>
            <span className="meta">
              {turn.modelRequests.length} requests · {turn.tools.length} tools
              {turn.usage
                ? ` · ${usage(
                    turn.usage.input_tokens,
                    turn.usage.output_tokens,
                    turn.usage.cache_read_tokens,
                  )}`
                : ""}
            </span>
            {canComment && (
              <NoteInput
                placeholder="review note for this turn"
                onComment={(body) => onComment(turn.turnId, body)}
              />
            )}
          </header>
          {turn.userMessage !== undefined && (
            <blockquote className="user-msg">
              <UserMessageContent
                sessionId={sessionId}
                text={turn.userMessage}
                images={turn.images}
                files={turn.files}
                onOpen={openImage}
              />
            </blockquote>
          )}
          {turn.userMessage === undefined &&
            (turn.images?.length ?? 0) + (turn.files?.length ?? 0) > 0 && (
              <blockquote className="user-msg">
                {/* empty text: both scans no-op, so this renders exactly the
                    trailing strips the refs would get in the text path */}
                <UserMessageContent
                  sessionId={sessionId}
                  text=""
                  images={turn.images}
                  files={turn.files}
                  onOpen={openImage}
                />
              </blockquote>
            )}
          <TurnComments
            comments={comments.filter((c) => c.turn_id === turn.turnId)}
            currentUser={currentUser}
            onDelete={onDeleteComment}
          />
          {turn.modelRequests.map((request) => (
            <div key={requestKey(request)} className="row">
              <span className="kind">request</span>
              <span
                className="detail"
                title={`${request.provider}/${request.model}`}
              >
                {request.model} · {fmtDuration(request.duration_ms)}
                {request.usage
                  ? ` · ${usage(request.usage.input_tokens, request.usage.output_tokens)}`
                  : ""}
              </span>
              <span className="meta">{clock(request.occurred_at)}</span>
            </div>
          ))}
          {turn.tools.map((tool, i) => (
            <div key={toolKey(tool, i)} className="row">
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
              {tool.result?.images !== undefined &&
                tool.result.images.length > 0 && (
                  <ToolImages
                    sessionId={sessionId}
                    shas={tool.result.images}
                    onOpen={openImage}
                  />
                )}
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
          {orphans.requests.map((request) => (
            <div key={requestKey(request)} className="row">
              <span className="kind">request</span>
              <span
                className="detail"
                title={`${request.provider}/${request.model}`}
              >
                {request.model} · {fmtDuration(request.duration_ms)}
              </span>
              <span className="meta">{clock(request.occurred_at)}</span>
            </div>
          ))}
          {orphans.tools.map((tool, i) => (
            <div key={toolKey(tool, i)} className="row">
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
