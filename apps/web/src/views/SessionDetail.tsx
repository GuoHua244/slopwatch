import { useMemo, useState } from "react";
import type { SessionSummary } from "../api";
import { useEventStream } from "../hooks/useEventStream";
import { clock, fmtTokens } from "../lib/format";
import { buildTimeline, isEnded } from "../lib/timeline";
import { RawEventsView } from "./RawEventsView";
import { TurnsView } from "./TurnsView";

type Tab = "turns" | "raw";

/** The selected session: identity facts, live state, and its activity. */
export const SessionDetail = ({ summary }: { summary: SessionSummary }) => {
  const stream = useEventStream(summary.session_id);
  const [tab, setTab] = useState<Tab>("turns");
  const timeline = useMemo(() => buildTimeline(stream.events), [stream.events]);
  const start = timeline.starts.at(-1);
  const lastEnd = timeline.ends.at(-1);
  const ended = isEnded(timeline);

  return (
    <div>
      <h2>{summary.title ?? "(untitled session)"}</h2>
      <p className={`state ${ended ? "down" : "live"}`}>
        {ended ? `ended · ${lastEnd?.reason ?? "unknown"}` : "running"}
        {stream.status === "down" ? " · stream connection lost" : ""}
      </p>
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
            {fmtTokens(summary.total_input_tokens)}in ·{" "}
            {fmtTokens(summary.total_output_tokens)}out ·{" "}
            {fmtTokens(summary.total_cache_read_tokens)}cache-read
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
        <TurnsView timeline={timeline} />
      ) : (
        <RawEventsView events={stream.events} />
      )}
    </div>
  );
};
