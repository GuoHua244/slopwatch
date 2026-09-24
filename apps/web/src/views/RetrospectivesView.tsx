import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MeInfo, RetroRow, StoredEvent } from "../api";
import type { RetroState } from "../hooks/useRetrospectives";
import { clock, fmtTokens } from "../lib/format";
import { ConfirmButton, ErrorBanner, useAsyncAction } from "./admin-shared";
import { Select } from "./Select";

const CUSTOM = "custom";

/** Rough pre-trigger estimate of the prompt's raw material (≈ bytes/3). */
const estimatePromptTokens = (events: StoredEvent[]): number =>
  Math.ceil(
    events.reduce((acc, e) => acc + JSON.stringify(e.event).length, 0) / 3,
  );

const angleTitle = (
  angles: { id: string; title: string }[],
  row: RetroRow,
): string =>
  angles.find((a) => a.id === row.angle)?.title ??
  (row.angle === CUSTOM ? "自由复盘" : row.angle);

/** "237 in · 380 out · 1.1k reasoning" — the run's own LLM spend (ADR 0008). */
const retroCost = (row: RetroRow): string => {
  const parts: string[] = [];
  if (row.input_tokens !== null)
    parts.push(`${fmtTokens(row.input_tokens)} in`);
  if (row.output_tokens !== null)
    parts.push(`${fmtTokens(row.output_tokens)} out`);
  if (row.cache_read_tokens)
    parts.push(`${fmtTokens(row.cache_read_tokens)} cache-read`);
  if (row.reasoning_tokens)
    parts.push(`${fmtTokens(row.reasoning_tokens)} reasoning`);
  return parts.join(" · ");
};

const runDuration = (row: RetroRow): string => {
  if (row.started_at === null || row.finished_at === null) return "";
  const ms = Date.parse(row.finished_at) - Date.parse(row.started_at);
  if (!Number.isFinite(ms) || ms < 0) return "";
  return ms >= 60_000
    ? `${(ms / 60_000).toFixed(1)} min`
    : `${(ms / 1000).toFixed(1)} s`;
};

const StatusChip = ({ status }: { status: RetroRow["status"] }) =>
  status === "running" ? (
    <span className="chip chip-live">running</span>
  ) : status === "failed" ? (
    <span className="chip chip-down">failed</span>
  ) : status === "pending" ? (
    <span className="chip">queued</span>
  ) : (
    <span className="chip chip-live">completed</span>
  );

/** The rendered report — markdown in, escaped HTML out (no rehype-raw). */
const RetroReport = ({ text }: { text: string }) => (
  <div className="retro-report">
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
  </div>
);

const RetroRun = ({
  row,
  angles,
  onRerun,
}: {
  row: RetroRow;
  angles: { id: string; title: string }[];
  onRerun: (row: RetroRow) => void;
}) => {
  const [open, setOpen] = useState(false);
  const cost = retroCost(row);
  const duration = runDuration(row);
  return (
    <div className={`retro-run${row.status === "failed" ? " failed" : ""}`}>
      <button
        type="button"
        className="retro-run-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="retro-run-title">
          {angleTitle(angles, row)}
          {row.supplement && (
            <span className="dim" title={row.supplement}>
              {" "}
              · +supplement
            </span>
          )}
        </span>
        <span className="retro-run-meta">
          <StatusChip status={row.status} />
          <span className="meta mono">
            {clock(row.created_at)}
            {duration ? ` · ${duration}` : ""}
          </span>
          <span className="seg-count">{open ? "▴" : "▾"}</span>
        </span>
      </button>
      {open && (
        <div className="retro-run-body">
          {(row.model || cost || row.user_id) && (
            <div className="retro-run-facts mono dim">
              {row.model && <span>model {row.model}</span>}
              {cost && <span>retro cost: {cost}</span>}
              {row.user_id && <span>triggered by {row.user_id}</span>}
            </div>
          )}
          {row.status === "completed" && row.result !== null && (
            <RetroReport text={row.result} />
          )}
          {row.status === "failed" && (
            <div className="retro-run-error">
              <p className="banner-error">{row.error ?? "the run failed"}</p>
              <ConfirmButton
                message={`rerun the "${angleTitle(angles, row)}" retrospective on your own LLM key?`}
                onClick={() => onRerun(row)}
              >
                Rerun
              </ConfirmButton>
            </div>
          )}
          {(row.status === "pending" || row.status === "running") && (
            <p className="dim">
              The report is being generated — this page picks it up within a few
              seconds.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

type Props = {
  sessionId: string;
  retro: RetroState;
  me: MeInfo | null;
  events: StoredEvent[];
};

/**
 * The Retrospectives tab (ADR 0008): a trigger bar over the run history.
 * Runs execute server-side on the triggering user's own LLM credentials and
 * carry their model + token spend next to the result.
 */
export const RetrospectivesView = ({ sessionId, retro, me, events }: Props) => {
  const [angles, setAngles] = useState<{ id: string; title: string }[]>([]);
  const [angle, setAngle] = useState("");
  const [supplement, setSupplement] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run = useAsyncAction((message) => {
    setFormError(message);
    if (message === null) setNotice(null);
  }, retro.refresh);

  useEffect(() => {
    let active = true;
    retro.api
      .angles()
      .then((list) => {
        if (!active) return;
        setAngles(list);
        setAngle((current) => current || list[0]?.id || "");
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [retro.api]);

  const llmReady = me !== null && me.llm !== null;
  const estimate = useMemo(() => estimatePromptTokens(events), [events]);

  const trigger = () =>
    void run(async () => {
      await retro.api.trigger(
        sessionId,
        angle,
        supplement.trim() ? supplement.trim() : undefined,
      );
      setSupplement("");
      setNotice("Retrospective queued — the run is executing on the server.");
    });

  const rerun = (row: RetroRow) =>
    void run(async () => {
      await retro.api.trigger(
        sessionId,
        row.angle,
        row.supplement ?? undefined,
      );
      retro.refresh();
    });

  return (
    <div className="retro">
      <div className="panel-card retro-trigger">
        <div className="card-head">
          <h3 className="card-title">Run a retrospective</h3>
          {estimate > 0 && (
            <span className="dim" style={{ fontSize: "12px" }}>
              ≈ <span className="mono">{fmtTokens(estimate)}</span> tokens of
              session material
            </span>
          )}
        </div>
        <p className="card-lede">
          An LLM critiques how this session was run — efficiency, token spend,
          tool and process choices — and proposes concrete improvements. The run
          bills to your own LLM credentials; the report is generated text, never
          evidence.
        </p>
        {!llmReady ? (
          <p className="dim">
            Retrospectives need your own LLM credentials —{" "}
            <a href="#/me">
              configure endpoint, model, and API key on your profile page
            </a>
            , then come back here.
          </p>
        ) : (
          <div className="retro-form">
            <Select
              label="Retrospective angle"
              value={angle}
              onChange={setAngle}
              options={angles.map((a) => ({ value: a.id, label: a.title }))}
            />
            <textarea
              className="retro-supplement"
              value={supplement}
              onChange={(e) => setSupplement(e.target.value)}
              placeholder={
                angle === CUSTOM
                  ? "写下你的复盘指令（必填）— 例如：检查这次会话的验证纪律，找出没跑测试就宣称完成的地方"
                  : "补充关注点（可选）— 例如：重点看第二次尝试改 schema 的那段"
              }
              rows={2}
            />
            <button
              className="primary"
              type="button"
              disabled={angle === ""}
              onClick={trigger}
            >
              Run retrospective
            </button>
          </div>
        )}
        <ErrorBanner message={formError} />
        {notice && <p className="dim">{notice}</p>}
        {retro.status === "down" && (
          <p className="dim">Run history unavailable · {retro.lastError}</p>
        )}
      </div>

      <div className="retro-runs">
        <h3 className="retro-runs-title">
          Past runs
          <span className="seg-count">{retro.retros.length}</span>
        </h3>
        {retro.retros.length === 0 ? (
          <p className="dim">No retrospectives yet — pick an angle above.</p>
        ) : (
          retro.retros.map((row) => (
            <RetroRun key={row.id} row={row} angles={angles} onRerun={rerun} />
          ))
        )}
      </div>
    </div>
  );
};
