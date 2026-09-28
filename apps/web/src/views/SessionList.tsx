import { useEffect, useRef } from "react";
import type { SessionSummary } from "../api";
import { fmtTokens, shortId, sinceDuration } from "../lib/format";

/** Events newer than this light the session's activity dot up. */
const ACTIVE_WINDOW_MS = 5 * 60_000;

/**
 * Strip file-transport noise that pre-dates the file-capture cleaning on the
 * listener: placeholders, `Attached <mime>: <path>` lines with their reader
 * instructions, and synthetic Read transcripts. Rows captured after that
 * cleaning are already clean and pass through unchanged.
 */
const cleanTaskPreview = (preview: string): string =>
  preview
    .replace(/\[(?:PDF|File|Image): source: [^\]]+\]/g, " ")
    // the capture-side 160-char cut can truncate mid-placeholder, leaving an
    // unclosed "[PDF: source: D:\…" tail that the closed-form regex misses
    .replace(/\[(?:PDF|File|Image): source: [^\]]*$/g, " ")
    .replace(
      /Attached \S+: \S+ The file was sent by local path.*?(?=Attached |Called the Read tool|$)/g,
      " ",
    )
    .replace(/Called the Read tool[\s\S]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

type Props = {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
};

export const SessionList = ({ sessions, selectedId, onSelect }: Props) => {
  // A deep-linked session (e.g. opened from the admin panel) can sit hundreds
  // of rows down, so the selection scrolls into view. Re-run only when the
  // selection or its presence in the list changes — the background poll
  // replaces `sessions` every few seconds and must not yank the scroll back.
  const selectedRef = useRef<HTMLLIElement | null>(null);
  const selectedInList = sessions.some((s) => s.session_id === selectedId);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedId, selectedInList]);
  return (
    <ul className="sessions">
      {sessions.map((s) => {
        const active =
          s.last_event_at !== null &&
          Date.now() - new Date(s.last_event_at).getTime() < ACTIVE_WINDOW_MS;
        const task = s.task_preview ? cleanTaskPreview(s.task_preview) : "";
        return (
          <li
            key={s.session_id}
            ref={s.session_id === selectedId ? selectedRef : undefined}
            className={s.session_id === selectedId ? "selected" : ""}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(s.session_id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(s.session_id);
              }
            }}
          >
            <span className="sess-top">
              <span className={`dot${active ? " live" : ""}`} />
              <span className="title">{s.title ?? shortId(s.session_id)}</span>
              <span className="when">
                {sinceDuration(s.last_event_at ?? s.first_seen_at)}
              </span>
            </span>
            <span className="sess-sub">
              {s.user_id ?? "?"} · {s.agent} · {fmtTokens(s.total_input_tokens)}
              /{fmtTokens(s.total_output_tokens)}
            </span>
            {task && <span className="task">{task}</span>}
          </li>
        );
      })}
    </ul>
  );
};
