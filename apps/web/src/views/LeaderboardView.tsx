import { Fragment, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useRollups } from "../hooks/useRollups";
import { useSessions } from "../hooks/useSessions";
import { useTeams } from "../hooks/useTeams";
import {
  clock,
  fmtCost,
  fmtDelta,
  fmtTokens,
  sinceDuration,
} from "../lib/format";
import { aggregateLeaderboard, type LeaderboardRow } from "../lib/leaderboard";
import { sparklinePoints } from "../lib/sparkline";

const rank = (index: number): string => String(index + 1).padStart(2, "0");

const WEEK_MS = 7 * 24 * 60 * 60_000;

type SortKey =
  | "todayCostUsd"
  | "costUsd"
  | "sessions"
  | "turns"
  | "inputTokens";

type Column = {
  key: SortKey | "developer" | "tokens" | "trend" | "lastSeen";
  label: string;
  title?: string;
  /** Numeric cells right-align; sortable columns get a click-to-sort header. */
  num?: boolean;
  sortable?: boolean;
  /** Which SortKey this column sorts by when it differs from key. */
  sortKey?: SortKey;
};

/* Nine readable columns instead of fourteen: team folds under the developer,
 * token streams merge into one cell, the 7d delta rides under the sparkline,
 * and requests/cache/top-agent wait in the per-developer drill-down. */
const COLUMNS: Column[] = [
  { key: "developer", label: "Developer" },
  {
    key: "todayCostUsd",
    label: "Today",
    title: "Local-today spend estimate — the default rank (decision 3)",
    num: true,
    sortable: true,
  },
  { key: "sessions", label: "Sessions", num: true, sortable: true },
  { key: "turns", label: "Turns", num: true, sortable: true },
  {
    key: "tokens",
    label: "Tokens in / out",
    title: "All-time input / output tokens; sorts by input",
    num: true,
    sortable: true,
    sortKey: "inputTokens",
  },
  {
    key: "trend",
    label: "24h",
    title:
      "Spend per UTC hour over the last 24 hours, vs the trailing 7-day mean",
  },
  { key: "lastSeen", label: "Last seen" },
  {
    key: "costUsd",
    label: "Cost est.",
    title: "All-time public list-price estimate — plan billing may differ",
    num: true,
    sortable: true,
  },
];

type RowWithTeam = LeaderboardRow & { teamName: string | null };

/** Sort value for a sortable column; the cost keys are nullable and sort as 0. */
const sortValue = (row: RowWithTeam, key: SortKey): string | number =>
  (row[key] ?? 0) as string | number;

/**
 * Body cells, keyed by column — COLUMNS is the single source of truth for
 * column order in both the header and the body.
 */
const CELL_RENDERERS: Record<
  Column["key"],
  (row: RowWithTeam, maxCost: number) => ReactNode
> = {
  developer: (row) => (
    <td>
      <span className="dev-cell">
        <span className="dev-name">{row.userId}</span>
        <span className="dev-team">{row.teamName ?? "unassigned"}</span>
      </span>
    </td>
  ),
  todayCostUsd: (row) => (
    <td className="num">
      <span className="today-cost">
        {row.todayCostUsd === null ? "—" : fmtCost(row.todayCostUsd)}
      </span>
    </td>
  ),
  sessions: (row) => <td className="num">{row.sessions}</td>,
  turns: (row) => <td className="num">{row.turns}</td>,
  /* sort-only key — the merged tokens column renders the in/out pair */
  inputTokens: (row) => <td className="num">{fmtTokens(row.inputTokens)}</td>,
  tokens: (row) => (
    <td className="num">
      {fmtTokens(row.inputTokens)} / {fmtTokens(row.outputTokens)}
    </td>
  ),
  trend: (row) => (
    <td className="spark">
      <span className="trend-cell">
        <svg
          viewBox="0 0 96 24"
          width="96"
          height="24"
          aria-hidden
          className={row.trend.every((v) => v === 0) ? "spark-flat" : undefined}
        >
          <polyline points={sparklinePoints(row.trend, 96, 24)} />
        </svg>
        <span
          className="delta"
          title={
            row.todayCostUsd === null
              ? undefined
              : `today ${fmtCost(row.todayCostUsd)}`
          }
        >
          {fmtDelta(row.deltaVsWeek)} vs 7d avg
        </span>
      </span>
    </td>
  ),
  lastSeen: (row) => (
    <td
      className="last-seen"
      title={row.lastActiveAt ? clock(row.lastActiveAt) : undefined}
    >
      {row.lastActiveAt ? `${sinceDuration(row.lastActiveAt)} ago` : "—"}
    </td>
  ),
  costUsd: (row, maxCost) => (
    <td className="num">
      {row.costUsd === null ? (
        "—"
      ) : (
        <span className="cost-cell">
          <span>{fmtCost(row.costUsd)}</span>
          <span
            className="share"
            style={{
              width: maxCost > 0 ? `${(row.costUsd / maxCost) * 100}%` : "0",
            }}
          />
        </span>
      )}
    </td>
  ),
};

/**
 * The developer leaderboard, served from the decision-18 rollups. The view
 * owns its reads: the team dropdown scopes the rollups AND the session facts
 * server-side, so every column in a row shares one denominator and the
 * sessions page's filter never leaks in (v2 decision 27). Today spend is the
 * default rank (decision 3); numeric headers sort; the toggle chips narrow to
 * developers active today / this week. Clicking a row drills into that
 * developer.
 */
export const LeaderboardView = () => {
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [activeToday, setActiveToday] = useState(false);
  const [activeWeek, setActiveWeek] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("todayCostUsd");
  const [sortDesc, setSortDesc] = useState(true);
  const rollups = useRollups({
    days: 8,
    hours: 8 * 24,
    ...(teamFilter === "all" ? {} : { teamId: teamFilter }),
  });
  const feed = useSessions(teamFilter === "all" ? null : teamFilter);
  const teams = useTeams();

  const rows = aggregateLeaderboard(feed.sessions, rollups);
  const teamByUser = useMemo(() => {
    const map = new Map<string, string>();
    for (const team of teams) {
      for (const member of team.members) map.set(member, team.name);
    }
    return map;
  }, [teams]);

  const rowsWithTeam: RowWithTeam[] = rows.map((row) => ({
    ...row,
    teamName: teamByUser.get(row.userId) ?? null,
  }));

  const visible = rowsWithTeam
    .filter((row) => !activeToday || row.todayRequests > 0)
    .filter(
      (row) =>
        !activeWeek ||
        (row.lastActiveAt !== "" &&
          Date.now() - new Date(row.lastActiveAt).getTime() < WEEK_MS),
    )
    .sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      let cmp: number;
      if (typeof va === "string" || typeof vb === "string") {
        cmp = String(va).localeCompare(String(vb));
      } else {
        cmp = va - vb;
      }
      return sortDesc ? -cmp : cmp;
    });

  const maxCost = Math.max(...rowsWithTeam.map((row) => row.costUsd ?? 0), 0);

  const toggleSort = (key: SortKey): void => {
    if (sortKey === key) setSortDesc(!sortDesc);
    else {
      setSortKey(key);
      setSortDesc(true);
    }
  };

  const sortMarker = (col: Column): string => {
    const key = col.sortKey ?? col.key;
    return sortKey === key ? (sortDesc ? " ↓" : " ↑") : "";
  };

  const teamSelect = (
    <label className="filter-pill">
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
        <path
          d="M1.5 2.5h9L7.3 6.4v3.2L4.7 8.2V6.4L1.5 2.5Z"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
      </svg>
      <select
        value={teamFilter}
        onChange={(e) => setTeamFilter(e.target.value)}
        aria-label="Filter leaderboard by team"
      >
        <option value="all">All teams</option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
        <option value="unassigned">Unassigned</option>
      </select>
    </label>
  );

  if (rows.length === 0)
    return (
      <>
        <div className="toolbar">{teamSelect}</div>
        <p className="empty">No activity yet.</p>
      </>
    );

  return (
    <>
      <div className="toolbar">
        {teamSelect}
        <label className="toggle-chip">
          <input
            type="checkbox"
            checked={activeToday}
            onChange={(e) => setActiveToday(e.target.checked)}
          />
          Active today
        </label>
        <label className="toggle-chip">
          <input
            type="checkbox"
            checked={activeWeek}
            onChange={(e) => setActiveWeek(e.target.checked)}
          />
          Active this week
        </label>
      </div>
      <div className="table-scroll">
        <table className="usage leaderboard">
          <thead>
            <tr>
              <th>#</th>
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className={col.num ? "num" : undefined}
                  title={col.title}
                  onClick={
                    col.sortable
                      ? () => toggleSort(col.sortKey ?? (col.key as SortKey))
                      : undefined
                  }
                  style={col.sortable ? { cursor: "pointer" } : undefined}
                >
                  {col.label}
                  {col.sortable ? sortMarker(col) : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => {
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
                  <td
                    className={`rank-cell${index === 0 ? " top" : index < 3 ? " top3" : ""}`}
                  >
                    {rank(index)}
                  </td>
                  {COLUMNS.map((col) => (
                    <Fragment key={col.key}>
                      {CELL_RENDERERS[col.key](row, maxCost)}
                    </Fragment>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
};
