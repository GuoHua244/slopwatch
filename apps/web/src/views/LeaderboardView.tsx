import type { SessionSummary } from "../api";
import { useSessionCosts } from "../hooks/useSessionCosts";
import { clock, fmtCost, fmtTokens } from "../lib/format";
import { aggregateLeaderboard } from "../lib/leaderboard";

const rank = (index: number): string => String(index + 1).padStart(2, "0");

/** The developer leaderboard: who is spending / working the most. */
export const LeaderboardView = ({
  sessions,
}: {
  sessions: SessionSummary[];
}) => {
  const stats = useSessionCosts(sessions);
  const rows = aggregateLeaderboard(sessions, stats);
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
          <th title="Public list-price estimate — plan billing may differ">
            cost est.
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={row.userId}>
            <td className="num dim">{rank(index)}</td>
            <td>{row.userId}</td>
            <td className="num">{row.sessions}</td>
            <td className="num">{row.turns}</td>
            <td className="num">{row.requests}</td>
            <td className="num">{fmtTokens(row.inputTokens)}</td>
            <td className="num">{fmtTokens(row.outputTokens)}</td>
            <td className="num">{fmtTokens(row.cacheReadTokens)}</td>
            <td>{row.topAgent}</td>
            <td className="dim">{clock(row.lastActiveAt)}</td>
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
                        maxCost > 0 ? `${(row.costUsd / maxCost) * 100}%` : "0",
                    }}
                  />
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};
