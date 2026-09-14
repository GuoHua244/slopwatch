import { Fragment, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useRollups } from "../hooks/useRollups";
import { useSessions } from "../hooks/useSessions";
import { useTeams } from "../hooks/useTeams";
import { clock, fmtCost, fmtDelta, fmtTokens } from "../lib/format";
import { aggregateLeaderboard, type LeaderboardRow } from "../lib/leaderboard";
import { sparklinePoints } from "../lib/sparkline";

const rank = (index: number): string => String(index + 1).padStart(2, "0");

type SortKey =
  | "todayCostUsd"
  | "costUsd"
  | "sessions"
  | "turns"
  | "requests"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "userId";

type Column = {
  key: SortKey | "team" | "topAgent" | "lastSeen" | "trend" | "delta";
  label: string;
  title?: string;
  /** Numeric cells right-align; sortable columns get a click-to-sort header. */
  num?: boolean;
  sortable?: boolean;
};

const COLUMNS: Column[] = [
  { key: "team", label: "team" },
  { key: "userId", label: "developer", sortable: true },
  {
    key: "todayCostUsd",
    label: "today",
    title: "Local-today spend estimate — the default rank (decision 3)",
    num: true,
    sortable: true,
  },
  { key: "sessions", label: "sessions", num: true, sortable: true },
  { key: "turns", label: "turns", num: true, sortable: true },
  { key: "requests", label: "requests", num: true, sortable: true },
  { key: "inputTokens", label: "in", num: true, sortable: true },
  { key: "outputTokens", label: "out", num: true, sortable: true },
  { key: "cacheReadTokens", label: "cache rd", num: true, sortable: true },
  { key: "topAgent", label: "top agent" },
  { key: "lastSeen", label: "last seen" },
  {
    key: "trend",
    label: "24h",
    title: "Spend per UTC hour over the last 24 hours",
  },
  {
    key: "delta",
    label: "vs 7d avg",
    title: "Local-today spend vs the trailing 7-day mean",
  },
  {
    key: "costUsd",
    label: "cost est.",
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
  team: (row) => (
    <td className={row.teamName ? undefined : "dim"}>
      {row.teamName ?? "unassigned"}
    </td>
  ),
  userId: (row) => <td>{row.userId}</td>,
  todayCostUsd: (row) => (
    <td className="num">
      {row.todayCostUsd === null ? "—" : fmtCost(row.todayCostUsd)}
    </td>
  ),
  sessions: (row) => <td className="num">{row.sessions}</td>,
  turns: (row) => <td className="num">{row.turns}</td>,
  requests: (row) => <td className="num">{row.requests}</td>,
  inputTokens: (row) => <td className="num">{fmtTokens(row.inputTokens)}</td>,
  outputTokens: (row) => <td className="num">{fmtTokens(row.outputTokens)}</td>,
  cacheReadTokens: (row) => (
    <td className="num">{fmtTokens(row.cacheReadTokens)}</td>
  ),
  topAgent: (row) => <td>{row.topAgent}</td>,
  lastSeen: (row) => (
    <td className="dim">{row.lastActiveAt ? clock(row.lastActiveAt) : "—"}</td>
  ),
  trend: (row) => (
    <td className="spark">
      <svg viewBox="0 0 96 24" width="96" height="24" aria-hidden>
        <polyline points={sparklinePoints(row.trend, 96, 24)} />
      </svg>
    </td>
  ),
  delta: (row) => (
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
 * default rank (decision 3); numeric headers sort, "active today only" hides
 * everyone with no requests in the local today. Clicking a row drills into
 * that developer.
 */
export const LeaderboardView = () => {
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [activeOnly, setActiveOnly] = useState(false);
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
    .filter((row) => !activeOnly || row.todayRequests > 0)
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

  const sortMarker = (key: Column["key"]): string =>
    sortKey === key ? (sortDesc ? " ↓" : " ↑") : "";

  const filterForm = (
    <form className="admin-form" onSubmit={(e) => e.preventDefault()}>
      <label className="dim">
        team{" "}
        <select
          value={teamFilter}
          onChange={(e) => setTeamFilter(e.target.value)}
        >
          <option value="all">all</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
          <option value="unassigned">unassigned</option>
        </select>
      </label>
      <label className="dim">
        <input
          type="checkbox"
          checked={activeOnly}
          onChange={(e) => setActiveOnly(e.target.checked)}
        />{" "}
        active today only
      </label>
    </form>
  );

  if (rows.length === 0)
    return (
      <>
        {filterForm}
        <p className="empty">no activity yet</p>
      </>
    );

  return (
    <>
      {filterForm}
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
                    ? () => toggleSort(col.key as SortKey)
                    : undefined
                }
                style={col.sortable ? { cursor: "pointer" } : undefined}
              >
                {col.label}
                {col.sortable ? sortMarker(col.key) : ""}
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
                <td className="num dim">{rank(index)}</td>
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
    </>
  );
};
