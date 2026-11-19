import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createApi, type WeeklyReportRow } from "../api";
import { errorMessage } from "../lib/format";
import { ErrorBanner } from "./admin-shared";

/** The window's last UTC day — until_day is the exclusive end. */
const lastDay = (untilDay: string): string =>
  new Date(Date.parse(`${untilDay}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);

/** One stored report: window, model, cost, and its rendered markdown. */
const ReportCard = ({ report }: { report: WeeklyReportRow }) => (
  <section className="weekly-card">
    <div className="card-head">
      <h3 className="card-title">
        {report.since_day} → {lastDay(report.until_day)}
      </h3>
      <span
        className={`chip ${report.status === "failed" ? "chip-down" : "chip-live"}`}
      >
        {report.status}
      </span>
      <span className="dim" style={{ fontSize: "12px" }}>
        {report.model ?? ""}
        {report.result !== null &&
          ` · ${fmtNum(report.input_tokens)} in / ${fmtNum(report.output_tokens)} out`}
        {" · "}
        {stamp(report.created_at)} · by {report.requested_by}
      </span>
    </div>
    {report.status === "failed" ? (
      <p className="banner-error">{report.error ?? "the run failed"}</p>
    ) : (
      <div className="weekly-report">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {report.result ?? ""}
        </ReactMarkdown>
      </div>
    )}
  </section>
);

const stamp = (iso: string): string => iso.slice(0, 16).replace("T", " ");

const fmtNum = (n: number | null): string =>
  n === null ? "?" : n.toLocaleString();

/**
 * v3 decision 36: the team weekly report — an admin pull, not a cron. One
 * click assembles the week's facts (rollup deltas, biggest sessions, the
 * commits the tools made) and critiques them with the requesting admin's
 * own LLM credentials. Generation is one synchronous LLM call — the button
 * stays busy until the stored row comes back.
 */
export const WeeklyReportView = () => {
  const api = useRef(createApi()).current;
  const [reports, setReports] = useState<WeeklyReportRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .weeklyReports()
      .then((rows) => {
        if (alive) setReports(rows);
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [api]);

  const generate = () => {
    if (generating) return;
    setGenerating(true);
    setActionError(null);
    api
      .generateWeeklyReport()
      .then((report) => {
        setReports((prev) => [report, ...(prev ?? [])]);
      })
      .catch((e: unknown) => {
        setActionError(errorMessage(e));
      })
      .finally(() => setGenerating(false));
  };

  return (
    <section className="panel-card">
      <div className="card-head">
        <h3 className="card-title">Weekly report</h3>
        <span className="dim" style={{ fontSize: "12px" }}>
          the trailing 7 UTC days, critiqued with your own LLM key
        </span>
        <button
          className="primary"
          disabled={generating}
          title="Runs one LLM call on your credentials; may take a minute"
          onClick={generate}
        >
          {generating ? "Generating…" : "Generate"}
        </button>
      </div>
      <ErrorBanner message={loadError ?? actionError} />
      {reports !== null && reports.length === 0 && (
        <p className="dim">No reports yet — generate the first one.</p>
      )}
      {reports?.slice(0, 5).map((report) => (
        <ReportCard key={report.id} report={report} />
      ))}
    </section>
  );
};
