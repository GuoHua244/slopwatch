import { useRollups } from "../hooks/useRollups";
import { useSessions } from "../hooks/useSessions";
import { clock, fmtCost, fmtDelta, fmtTokens } from "../lib/format";
import { aggregateLeaderboard, dailyCostSeries } from "../lib/leaderboard";

/**
 * The leaderboard drill-down (decision 18): one developer's 30-day spend
 * chart plus their sessions. Sessions deep-link into the existing session
 * detail; everything is derived from the same rollups snapshot the table
 * uses, so no extra endpoints were needed. The view fetches its own org-wide
 * session list — the sessions page's team filter must not shrink it.
 */
export const DeveloperDetail = ({ userId }: { userId: string }) => {
  // 31 local days of spend need hourly rows (v2 decision 27): daily display
  // re-buckets UTC hours into the viewer's calendar days.
  const rollups = useRollups({ days: 31, hours: 31 * 24 });
  const feed = useSessions(null);
  const row =
    aggregateLeaderboard(feed.sessions, rollups).find(
      (candidate) => candidate.userId === userId,
    ) ?? null;
  const series = dailyCostSeries(
    rollups.model_hourly.filter((r) => r.user_id === userId),
    31,
  );
  const maxDay = Math.max(...series.map((d) => d.cost), 0);
  const lastSeen = (s: (typeof feed.sessions)[number]): string =>
    s.last_event_at ?? s.first_seen_at;
  const userSessions = feed.sessions
    .filter((s) => (s.user_id ?? "(unknown)") === userId)
    .sort((a, b) => lastSeen(b).localeCompare(lastSeen(a)));

  return (
    <div className="developer">
      <p>
        <a href="#/leaderboard">← leaderboard</a>
      </p>
      <h2>{userId}</h2>
      {row === null ? (
        <p className="empty">no activity recorded for this developer</p>
      ) : (
        <>
          <dl className="chips">
            <div>
              <dt>sessions</dt>
              <dd className="num">{row.sessions}</dd>
            </div>
            <div>
              <dt>turns</dt>
              <dd className="num">{row.turns}</dd>
            </div>
            <div>
              <dt>requests</dt>
              <dd className="num">{row.requests}</dd>
            </div>
            <div>
              <dt>tokens in / out</dt>
              <dd className="num">
                {fmtTokens(row.inputTokens)} / {fmtTokens(row.outputTokens)}
              </dd>
            </div>
            <div>
              <dt>cost est.</dt>
              <dd className="num">
                {row.costUsd === null ? "—" : fmtCost(row.costUsd)}
              </dd>
            </div>
            <div>
              <dt>today vs 7d avg</dt>
              <dd className="num">
                {row.todayCostUsd === null
                  ? fmtDelta(row.deltaVsWeek)
                  : `${fmtCost(row.todayCostUsd)} · ${fmtDelta(row.deltaVsWeek)}`}
              </dd>
            </div>
          </dl>
          <h3>daily spend, last 30 days (local days)</h3>
          <div
            className="bars"
            role="img"
            aria-label="daily spend, last 30 days"
          >
            {series.slice(0, -1).map((d) => (
              <div
                key={d.day}
                className={`bar${d.unpriced ? " unpriced" : ""}`}
                title={`${d.day} · ${d.unpriced ? "partly unpriced" : fmtCost(d.cost)}`}
                style={{
                  height: maxDay > 0 ? `${(d.cost / maxDay) * 100}%` : "0",
                }}
              />
            ))}
          </div>
          <p className="dim">
            {series[0]?.day} → {series[series.length - 2]?.day} · today{" "}
            {row.todayCostUsd === null ? "—" : fmtCost(row.todayCostUsd)}
          </p>
        </>
      )}
      <h3>sessions</h3>
      {userSessions.length === 0 ? (
        <p className="empty">no sessions</p>
      ) : (
        <table className="usage">
          <thead>
            <tr>
              <th>session</th>
              <th>agent</th>
              <th>in</th>
              <th>out</th>
              <th>first seen</th>
            </tr>
          </thead>
          <tbody>
            {userSessions.map((s) => (
              <tr key={s.session_id}>
                <td>
                  <a href={`#/sessions/${encodeURIComponent(s.session_id)}`}>
                    {s.title ?? s.task_preview ?? s.session_id}
                  </a>
                </td>
                <td>{s.agent}</td>
                <td className="num">{fmtTokens(s.total_input_tokens)}</td>
                <td className="num">{fmtTokens(s.total_output_tokens)}</td>
                <td className="dim">{clock(s.first_seen_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
