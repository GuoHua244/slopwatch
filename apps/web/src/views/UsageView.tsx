import type { StoredEvent } from "../api";
import { modelBreakdown, sessionTotals } from "../lib/aggregate";
import { fmtCost, fmtDuration, fmtTokens } from "../lib/format";

/** Per-model token/duration/cost rollup for one session. */
export const UsageView = ({ events }: { events: StoredEvent[] }) => {
  const rows = modelBreakdown(events);
  const totals = sessionTotals(events);
  if (totals.requests === 0) return null;
  return (
    <table className="usage">
      <thead>
        <tr>
          <th>model</th>
          <th>req</th>
          <th>in</th>
          <th>out</th>
          <th>cache rd</th>
          <th>duration</th>
          <th title="Public list-price estimate — plan billing may differ">
            cost est.
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.model}>
            <td>
              {row.provider}/{row.model}
            </td>
            <td className="num">{row.requests}</td>
            <td className="num">{fmtTokens(row.inputTokens)}</td>
            <td className="num">{fmtTokens(row.outputTokens)}</td>
            <td className="num">{fmtTokens(row.cacheReadTokens)}</td>
            <td className="num">{fmtDuration(row.durationMs)}</td>
            <td className="num">
              {row.costUsd === null ? "—" : fmtCost(row.costUsd)}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td>total</td>
          <td className="num">{totals.requests}</td>
          <td className="num">{fmtTokens(totals.inputTokens)}</td>
          <td className="num">{fmtTokens(totals.outputTokens)}</td>
          <td className="num">{fmtTokens(totals.cacheReadTokens)}</td>
          <td className="num">{fmtDuration(totals.durationMs)}</td>
          <td className="num">
            {totals.costUsd === null ? "—" : fmtCost(totals.costUsd)}
          </td>
        </tr>
      </tfoot>
    </table>
  );
};
