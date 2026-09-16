import type { SessionSummary } from "../api";
import { fmtTokens, shortId, sinceDuration } from "../lib/format";

/** Events newer than this light the session's activity dot up. */
const ACTIVE_WINDOW_MS = 5 * 60_000;

type Props = {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
};

export const SessionList = ({ sessions, selectedId, onSelect }: Props) => (
  <ul className="sessions">
    {sessions.map((s) => {
      const active =
        s.last_event_at !== null &&
        Date.now() - new Date(s.last_event_at).getTime() < ACTIVE_WINDOW_MS;
      return (
        <li
          key={s.session_id}
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
            {s.user_id ?? "?"} · {s.agent} · {fmtTokens(s.total_input_tokens)}/
            {fmtTokens(s.total_output_tokens)}
          </span>
          {s.task_preview && <span className="task">{s.task_preview}</span>}
        </li>
      );
    })}
  </ul>
);
