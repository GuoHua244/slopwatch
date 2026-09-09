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

export const TurnsView = ({ timeline }: { timeline: SessionTimeline }) => {
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
          </header>
          {turn.userMessage && (
            <blockquote className="user-msg">{turn.userMessage}</blockquote>
          )}
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
                  : " · running…"}
              </span>
            </div>
          ))}
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
