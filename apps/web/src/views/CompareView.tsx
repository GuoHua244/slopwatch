import { useState } from "react";
import type { ModelRollupRow } from "../api";
import { useRollups } from "../hooks/useRollups";
import { type ModelStats, modelsInWindow, modelStats } from "../lib/compare";
import { fmtCost, fmtTokens } from "../lib/format";
import { sparklinePoints } from "../lib/sparkline";
import { Select } from "./Select";

const WINDOWS = [7, 30, 90] as const;

const statRows = (
  stats: ModelStats,
): { label: string; value: string; title?: string }[] => [
  { label: "Requests", value: stats.requests.toLocaleString() },
  { label: "Tokens in", value: fmtTokens(stats.inputTokens) },
  { label: "Tokens out", value: fmtTokens(stats.outputTokens) },
  { label: "Cache read", value: fmtTokens(stats.cacheReadTokens) },
  { label: "Cache write", value: fmtTokens(stats.cacheWriteTokens) },
  {
    label: "Tokens / request",
    value:
      stats.tokensPerRequest === null
        ? "—"
        : fmtTokens(Math.round(stats.tokensPerRequest)),
    title: "Total tokens (in+out+cache) divided by requests",
  },
  {
    label: "Cost est.",
    value: stats.costUsd === null ? "—" : fmtCost(stats.costUsd),
    title: "List-price estimate over the window — plan billing may differ",
  },
];

const ModelCard = ({ stats }: { stats: ModelStats }) => (
  <div className="compare-card">
    <h3 className="compare-model">{stats.model}</h3>
    <table className="compare-table">
      <tbody>
        {statRows(stats).map((row) => (
          <tr key={row.label}>
            <th title={row.title}>{row.label}</th>
            <td>{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <svg
      className="compare-spark"
      viewBox="0 0 160 32"
      width="160"
      height="32"
      role="img"
      aria-label={`${stats.model} total tokens per UTC day`}
    >
      <polyline points={sparklinePoints(stats.daily, 160, 32)} />
    </svg>
    <p className="dim compare-note">
      {fmtTokens(stats.totalTokens)} over the window · daily UTC burn
    </p>
  </div>
);

/**
 * v3 decision 35: two models side by side over the same window — the
 * observational answer to "which model burns less on our actual workloads".
 * The rows the reader sees are the rollups they are already allowed to see:
 * org-wide for an admin, their own for a member. Same window both sides, so
 * the comparison stays honest about workload mix; no "winner" is declared —
 * more tokens is not worse per se.
 */
export const CompareView = () => {
  const [days, setDays] = useState<number>(30);
  const { snapshot, lastError } = useRollups({ days });
  const rows: ModelRollupRow[] = snapshot.model_daily;
  const models = modelsInWindow(rows);
  const [aPick, setAPick] = useState<string | null>(null);
  const [bPick, setBPick] = useState<string | null>(null);
  const modelA = aPick ?? models[0] ?? null;
  const modelB = bPick ?? models[1] ?? null;
  const statsA = modelA === null ? null : modelStats(rows, modelA, days);
  const statsB = modelB === null ? null : modelStats(rows, modelB, days);

  const options = models.map((m) => ({ value: m, label: m }));
  const windowSelect = (
    <div className="filter-pill">
      <Select
        label="Comparison window"
        value={String(days)}
        onChange={(v) => setDays(Number(v))}
        options={WINDOWS.map((w) => ({ value: String(w), label: `${w}d` }))}
      />
    </div>
  );

  if (models.length < 2)
    return (
      <>
        {lastError && <p className="banner-error">{lastError}</p>}
        <div className="toolbar">{windowSelect}</div>
        <p className="empty">
          Not enough models in this window yet — the comparison needs two.
        </p>
      </>
    );

  return (
    <>
      {lastError && <p className="banner-error">{lastError}</p>}
      <div className="toolbar">
        {windowSelect}
        <div className="filter-pill">
          <Select
            label="Model A"
            value={modelA ?? ""}
            onChange={setAPick}
            options={options}
          />
        </div>
        <span className="dim">vs</span>
        <div className="filter-pill">
          <Select
            label="Model B"
            value={modelB ?? ""}
            onChange={setBPick}
            options={options}
          />
        </div>
      </div>
      {statsA && statsB && (
        <div className="compare-grid">
          <ModelCard stats={statsA} />
          <ModelCard stats={statsB} />
        </div>
      )}
      <p className="dim compare-lede">
        Observed workloads over the same window — the mix of tasks each model
        ran is whatever the team actually did, not a controlled benchmark.
      </p>
    </>
  );
};
