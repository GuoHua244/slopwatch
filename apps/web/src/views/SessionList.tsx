import type { SessionSummary } from "../api";
import { clock, fmtTokens, shortId } from "../lib/format";

type Props = {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
};

export const SessionList = ({ sessions, selectedId, onSelect }: Props) => (
  <ul className="sessions">
    {sessions.map((s) => (
      <li
        key={s.session_id}
        className={s.session_id === selectedId ? "selected" : ""}
        onClick={() => onSelect(s.session_id)}
      >
        <span className="title">{s.title ?? "(untitled)"}</span>
        <span className="sid">
          {shortId(s.session_id)} · {s.agent} · {clock(s.first_seen_at)}
        </span>
        <span className="meta">
          {s.user_id ?? "?"} · {fmtTokens(s.total_input_tokens)}in/
          {fmtTokens(s.total_output_tokens)}out
          {s.total_cache_read_tokens > 0
            ? ` · ${fmtTokens(s.total_cache_read_tokens)}cache`
            : ""}{" "}
          · seq {s.last_seq}
        </span>
        {s.task_preview && <span className="task">{s.task_preview}</span>}
      </li>
    ))}
  </ul>
);
