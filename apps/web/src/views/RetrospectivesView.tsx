import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MeInfo, RetroRow, StoredEvent } from "../api";
import type { RetroState } from "../hooks/useRetrospectives";
import { useFormFeedback } from "../hooks/useFormFeedback";
import { clock, fmtTokens } from "../lib/format";
import { ConfirmButton, ErrorBanner } from "./admin-shared";
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

/** "12,345" — thousands-grouped live output counter on a streaming run. */
const fmtChars = (n: number): string => n.toLocaleString("en-US");

const runDuration = (row: RetroRow): string => {
  if (row.started_at === null || row.finished_at === null) return "";
  const ms = Date.parse(row.finished_at) - Date.parse(row.started_at);
  if (!Number.isFinite(ms) || ms < 0) return "";
  return ms >= 60_000
    ? `${(ms / 60_000).toFixed(1)} min`
    : `${(ms / 1000).toFixed(1)} s`;
};

/** "42s" / "12:34" / "1:02:34" — the ticking readout on an in-flight run. */
const fmtElapsed = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}:${two(s % 60)}`
      : `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
};

/** Re-renders once a second while `active` so the elapsed readout ticks. */
const useNow = (active: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
};

const StatusChip = ({
  status,
  elapsed,
}: {
  status: RetroRow["status"];
  elapsed?: string;
}) => {
  const withElapsed = (label: string) =>
    elapsed ? `${label} · ${elapsed}` : label;
  if (status === "running")
    return (
      <span className="chip chip-live chip-running">
        {withElapsed("running")}
      </span>
    );
  if (status === "failed")
    return <span className="chip chip-down">failed</span>;
  if (status === "pending")
    return <span className="chip">{withElapsed("queued")}</span>;
  return <span className="chip chip-live">completed</span>;
};

/** The rendered report — markdown in, escaped HTML out (no rehype-raw). */
const RetroReport = ({ text }: { text: string }) => (
  <div className="retro-report">
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
  </div>
);

/**
 * The longest run of the new snapshot's head that continues the previous
 * one's tail — the streaming window slides left as it grows, so the fresh
 * chars are the part after this overlap. Below a floor the snapshots don't
 * line up (window truncation outran them) and the caller snaps instead.
 */
const tailOverlap = (prev: string, next: string): number => {
  const max = Math.min(prev.length, next.length);
  for (let k = max; k >= 24; k--) {
    if (prev.endsWith(next.slice(0, k))) return k;
  }
  return -1;
};

/** One timer-driven typewriter drain between polled tail snapshots. */
const RetroTail = ({ text }: { text: string }) => {
  const ref = useRef<HTMLSpanElement>(null);
  const state = useRef({ shown: "", timer: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const st = state.current;
    clearInterval(st.timer);
    const prev = st.shown;
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const from = reduce || prev === "" ? -1 : tailOverlap(prev, text);
    const write = (s: string) => {
      el.textContent = `…${s}`;
      st.shown = s;
    };
    if (from < 0) {
      write(text);
      return;
    }
    // Reveal the fresh chars over roughly one poll gap — paced near the
    // model's own output speed so the next snapshot lands as this ends.
    // An interval, not rAF: occluded webviews freeze rAF entirely but
    // still fire timers (throttled), so the line at least creeps forward.
    const duration = Math.min(1100, Math.max(220, (text.length - from) * 6));
    const start = performance.now();
    st.timer = window.setInterval(() => {
      const p = Math.min(1, (performance.now() - start) / duration);
      write(text.slice(0, from + Math.round((text.length - from) * p)));
      if (p >= 1) clearInterval(st.timer);
    }, 30);
    return () => clearInterval(st.timer);
  }, [text]);
  return <span ref={ref} />;
};

const RetroRun = ({
  row,
  angles,
  llmModel,
  onRerun,
}: {
  row: RetroRow;
  angles: { id: string; title: string }[];
  /** The triggering user's configured model, shown while awaiting first byte. */
  llmModel: string | null;
  onRerun: (row: RetroRow) => void;
}) => {
  // An in-flight run mounts expanded and stays expanded, so the report
  // appears exactly where the progress line was.
  const inFlight = row.status === "pending" || row.status === "running";
  const [open, setOpen] = useState(inFlight);
  const now = useNow(inFlight);
  const elapsed = fmtElapsed(
    now - Date.parse(row.started_at ?? row.created_at),
  );
  // Seconds since the run's last progress write; past 30 the endpoint has
  // gone quiet. Negative diffs (the browser clock ahead of the server's)
  // clamp to 0 — the two clocks are never exactly in sync.
  const staleSecs = row.heartbeat_at
    ? Math.max(0, Math.floor((now - Date.parse(row.heartbeat_at)) / 1000))
    : 0;
  const cost = retroCost(row);
  const duration = runDuration(row);
  return (
    <div
      className={`retro-run${row.status === "failed" ? " failed" : ""}${inFlight ? " running" : ""}`}
    >
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
          <StatusChip
            status={row.status}
            elapsed={inFlight ? elapsed : undefined}
          />
          <span className="meta mono">
            {clock(row.created_at)}
            {duration ? ` · ${duration}` : ""}
          </span>
          <span className="seg-count">{open ? "▴" : "▾"}</span>
        </span>
      </button>
      {inFlight && <div className="retro-run-progress" aria-hidden />}
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
          {inFlight && (
            <p className="retro-run-progress-note">
              <span className="spin" aria-hidden />
              <span>
                {row.status === "pending"
                  ? "Queued — the run starts as soon as the server picks it up."
                  : row.phase === "streaming"
                    ? `已输出 ${fmtChars(row.output_chars ?? 0)} 字符 · ${elapsed}`
                    : `${llmModel ? `${llmModel} · ` : ""}已等待 ${elapsed}（上限 5 分钟）`}
                {/*
                 * The heartbeat warning only watches the streaming phase:
                 * a slow first byte is a legal long prefill, not a hang.
                 */}
                {row.status === "running" &&
                  row.phase === "streaming" &&
                  staleSecs > 30 && (
                    <span className="dim">
                      {" "}
                      · 无活动 {staleSecs}s —— 端点可能挂起
                    </span>
                  )}
              </span>
            </p>
          )}
          {inFlight && row.phase === "streaming" && row.output_tail && (
            // The generated text's rolling tail, ZCode-thinking style: the
            // early phase shows reasoning prose, then the report takes over.
            // Snapshots land ~1s apart; RetroTail drains them character by
            // character so the line reads as a flow, not a slideshow.
            <div className="retro-run-tail mono dim" aria-live="off">
              <RetroTail text={row.output_tail} />
            </div>
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
  const { formError, setFormError, notice, setNotice, run } = useFormFeedback(
    retro.refresh,
  );

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
            <RetroRun
              key={row.id}
              row={row}
              angles={angles}
              // The run bills to its triggerer's credentials, so the model
              // to expect is the viewer's own config — never shown for
              // someone else's run.
              llmModel={
                row.user_id === me?.user ? (me?.llm?.model ?? null) : null
              }
              onRerun={rerun}
            />
          ))
        )}
      </div>
    </div>
  );
};
