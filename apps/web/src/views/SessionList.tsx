import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary } from "../api";
import { fmtTokens, shortId, sinceDuration } from "../lib/format";
import { buildSessionForest, stripSubagentPrefix } from "../lib/sessionTree";

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

  const { roots, childrenOf } = useMemo(
    () => buildSessionForest(sessions),
    [sessions],
  );
  // Subagent branches start folded; the twistie unfolds one. Survives the
  // 5s poll — the component stays mounted while `sessions` is replaced.
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // The selection can sit inside a folded branch (deep link, auto-follow of
  // a fresh subagent), so its ancestors are revealed regardless of the
  // operator's folds.
  const open = useMemo(() => {
    const byId = new Map(sessions.map((s) => [s.session_id, s]));
    const revealed = new Set(unfolded);
    let cur = selectedId === null ? undefined : byId.get(selectedId);
    while (cur && cur.parent_session_id !== null) {
      revealed.add(cur.parent_session_id);
      cur = byId.get(cur.parent_session_id);
    }
    return revealed;
  }, [unfolded, sessions, selectedId]);

  const toggle = (id: string) =>
    setUnfolded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const row = (s: SessionSummary, nested: boolean) => {
    const kids = childrenOf.get(s.session_id) ?? [];
    const unfoldable = kids.length > 0;
    const isOpen = open.has(s.session_id);
    const active =
      s.last_event_at !== null &&
      Date.now() - new Date(s.last_event_at).getTime() < ACTIVE_WINDOW_MS;
    const task = s.task_preview ? cleanTaskPreview(s.task_preview) : "";
    // Orphaned subagents (parent outside the fetched window) keep a chip —
    // nesting can't mark them; nested rows are marked by the tree itself.
    const orphan = !nested && s.parent_session_id !== null;
    return (
      <li
        key={s.session_id}
        ref={s.session_id === selectedId ? selectedRef : undefined}
        className={s.session_id === selectedId ? "selected" : ""}
        role="button"
        tabIndex={0}
        onClick={(e) => {
          // a subagent row lives inside its parent's <li> — without this the
          // click bubbles up and the ancestor's onSelect overwrites the child
          // selection in the same batch, so the pane never leaves the parent
          e.stopPropagation();
          onSelect(s.session_id);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            onSelect(s.session_id);
          }
        }}
      >
        <span className="sess-top">
          {unfoldable && (
            <button
              type="button"
              className={`twistie${isOpen ? " open" : ""}`}
              aria-expanded={isOpen}
              aria-label={
                isOpen
                  ? "Fold subagent sessions"
                  : `Unfold ${kids.length} subagent session${kids.length === 1 ? "" : "s"}`
              }
              title={
                isOpen ? "Fold subagent sessions" : "Unfold subagent sessions"
              }
              onClick={(e) => {
                e.stopPropagation();
                toggle(s.session_id);
              }}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <svg width="9" height="9" viewBox="0 0 8 8" aria-hidden="true">
                <path
                  d="M2.5 1l3.5 3-3.5 3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {kids.length}
            </button>
          )}
          <span className={`dot${active ? " live" : ""}`} />
          {orphan && <span className="chip">subagent</span>}
          <span className="title">
            {stripSubagentPrefix(s.title) ?? shortId(s.session_id)}
          </span>
          <span className="when">
            {sinceDuration(s.last_event_at ?? s.first_seen_at)}
          </span>
        </span>
        <span className="sess-sub">
          {s.user_id ?? "?"} · {s.agent} · {fmtTokens(s.total_input_tokens)}/
          {fmtTokens(s.total_output_tokens)}
        </span>
        {task && <span className="task">{task}</span>}
        {unfoldable && isOpen && (
          <ul className="sessions sub">{kids.map((k) => row(k, true))}</ul>
        )}
      </li>
    );
  };

  return <ul className="sessions">{roots.map((s) => row(s, false))}</ul>;
};
