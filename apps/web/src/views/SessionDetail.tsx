import type { SessionSummary } from "../api";
import { clock, fmtTokens } from "../lib/format";

/** F1 scope: identity + token totals. The event stream lands in F2. */
export const SessionDetail = ({ summary }: { summary: SessionSummary }) => (
  <div>
    <h2>{summary.title ?? "(untitled session)"}</h2>
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
        <dt>last seq</dt>
        <dd className="mono">{summary.last_seq}</dd>
      </div>
      <div>
        <dt>tokens</dt>
        <dd className="mono">
          {fmtTokens(summary.total_input_tokens)}in ·{" "}
          {fmtTokens(summary.total_output_tokens)}out ·{" "}
          {fmtTokens(summary.total_cache_read_tokens)}cache-read
        </dd>
      </div>
      {summary.task_preview && (
        <div className="wide">
          <dt>task</dt>
          <dd>{summary.task_preview}</dd>
        </div>
      )}
    </dl>
  </div>
);
