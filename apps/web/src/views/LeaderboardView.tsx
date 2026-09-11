import type { SessionSummary } from "../api";
import { useRollups } from "../hooks/useRollups";
import { clock, fmtCost, fmtDelta, fmtTokens } from "../lib/format";
import { aggregateLeaderboard } from "../lib/leaderboard";
import { sparklinePoints } from "../lib/sparkline";

const rank = (index: number): string => String(index + 1).padStart(2, "0");

/**
 * The developer leaderboard, served from the decision-18 rollups — one
 * rollups call plus the session list, no per-session event fetching. Clicking
 * a row drills into that developer (the "(unknown)" bucket has no identity to
 * drill into).
 */
export const LeaderboardView = ({
  sessions,
}: {
  sessions: SessionSummary[];
}) => {
  const rollups = useRollups({ days: 8 });
  const rows = aggregateLeaderboard(sessions, rollups);
  if (rows.length === 0) return <p className="empty">no sessions yet</p>;
  const maxCost = Math.max(...rows.map((row) => row.costUsd ?? 0), 0);
  return (
    <table className="usage leaderboard">
      <thead>
        <tr>
          <th>#</th>
          <th>developer</th>
          <th>sessions</th>
          <th>turns</th>
          <th>requests</th>
          <th>in</th>
          <th>out</th>
          <th>cache rd</th>
          <th>top agent</th>
          <th>last seen</th>
          <th title="Spend per UTC hour over the last 24 hours">24h</th>
          <th title="UTC-today spend vs the trailing 7-day mean">vs 7d avg</th>
          <th title="Public list-price estimate — plan billing may differ">
            cost est.
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => {
          const drillable =
            row.userId !== "(unknown)" && row.sessions > 0
              ? `#/leaderboard/${encodeURIComponent(row.userId)}`
              : null;
          return (
            <tr
              key={row.userId}
              className={drillable ? "row-link" : undefined}
              onClick={
                drillable
                  ? () => {
                      window.location.hash = drillable;
                    }
                  : undefined
              }
            >
              <td className="num dim">{rank(index)}</td>
              <td>{row.userId}</td>
              <td className="num">{row.sessions}</td>
              <td className="num">{row.turns}</td>
              <td className="num">{row.requests}</td>
              <td className="num">{fmtTokens(row.inputTokens)}</td>
              <td className="num">{fmtTokens(row.outputTokens)}</td>
              <td className="num">{fmtTokens(row.cacheReadTokens)}</td>
              <td>{row.topAgent}</td>
              <td className="dim">
                {row.lastActiveAt ? clock(row.lastActiveAt) : "—"}
              </td>
              <td className="spark">
                <svg viewBox="0 0 96 24" width="96" height="24" aria-hidden>
                  <polyline points={sparklinePoints(row.trend, 96, 24)} />
                </svg>
              </td>
              <td
                className="num dim"
                title={
                  row.todayCostUsd === null
                    ? undefined
                    : `today ${fmtCost(row.todayCostUsd)}`
                }
              >
                {fmtDelta(row.deltaVsWeek)}
              </td>
              <td className="num">
                {row.costUsd === null ? (
                  "—"
                ) : (
                  <span className="cost-cell">
                    <span>{fmtCost(row.costUsd)}</span>
                    <span
                      className="share"
                      style={{
                        width:
                          maxCost > 0
                            ? `${(row.costUsd / maxCost) * 100}%`
                            : "0",
                      }}
                    />
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};
