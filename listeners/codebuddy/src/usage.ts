/**
 * Token usage for CodeBuddy sessions — which does NOT live in the transcript.
 *
 * Measured 2026-10-08: no message file anywhere in a 42-message session
 * carries a `usage` key. The only place counts appear is the workspace's
 * per-day agent log, one line per assistant step (research/codebuddy-capture-
 * surfaces.md §4):
 *
 *   [2026/10/8 18:38:04.276] [Info] [BaseAgent:craft] [<requestId>]  notifyStepEnd, step: 1, requestId: …, messageId: …, usage: {"inputTokens":12633,…}, isMaxTokenLimit: false, …
 *   [2026/10/8 18:38:04.276] [Info] [AgentReporter] [<traceId>]  Step execution metrics: step=1, duration=4381ms, usage={…}
 *
 * Both lines for one step share the timestamp to the millisecond, so the
 * duration from the second repairs the usage from the first. The join back to
 * the transcript is `messageId` (also `requestId`), both of which every
 * assistant message carries in its `extra`.
 *
 * `inputTokens` is that step's whole prompt (it grows step over step), i.e.
 * per-model-request prompt tokens — the same accounting Claude Code's
 * transcript uses, so cross-agent totals stay comparable.
 */
import type { TokenUsage } from "@slopwatch/events";

export type UsageRecord = {
  /** Timestamp printed on the log line (local clock). */
  occurredAt: string;
  step: number | null;
  requestId: string | null;
  messageId: string | null;
  /**
   * The `BaseAgent:<type>` prefix of the line — `craft` for the session's
   * own steps, another type (e.g. `code-explorer`) for a sub-agent run.
   * This is how sub-agent tokens are told apart from the parent's.
   */
  agentPrefix: string | null;
  usage: TokenUsage;
  durationMs: number | null;
};

const LINE_TS = /^\[(\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}\.\d{3})\]/;
const USAGE_BLOCK = /usage:\s*(\{[^}]*\})/;
const METRICS = /Step execution metrics:\s*step=(\d+),\s*duration=(\d+)ms/;
const AGENT_PREFIX = /\[BaseAgent:([^\]]+)\]/;
const STEP = /\bstep:\s*(\d+)/;
const ID_AFTER = (name: string): RegExp =>
  new RegExp(`${name}:\\s*([0-9a-fA-F][0-9a-fA-F-]*)`);

const usageTokens = (raw: unknown): TokenUsage | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const source = raw as Record<string, unknown>;
  const num = (key: string): number | undefined => {
    const v = source[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined;
    // token counts land in bigint columns — never emit a fraction
    return Math.trunc(v);
  };
  const usage: TokenUsage = {};
  const input = num("inputTokens");
  const output = num("outputTokens");
  const cacheRead = num("cacheTokens");
  const cacheWrite = num("cachedWriteTokens");
  const reasoning = num("thinkingTokens");
  if (input !== undefined) usage.input_tokens = input;
  if (output !== undefined) usage.output_tokens = output;
  if (cacheRead !== undefined) usage.cache_read_tokens = cacheRead;
  if (cacheWrite !== undefined) usage.cache_write_tokens = cacheWrite;
  if (reasoning !== undefined) usage.reasoning_tokens = reasoning;
  return Object.keys(usage).length > 0 ? usage : null;
};

const LINE_TS_PARTS =
  /^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})\.(\d{3})$/;

/**
 * The log prints single-digit months and days (`2026/10/8 18:38:04.276`) —
 * padding matters, because `new Date("2026-10-8T…")` is an Invalid Date and
 * would silently drop every usage line the house style written by a loop.
 */
const lineTimestamp = (line: string): string | null => {
  const stamp = line.match(LINE_TS)?.[1];
  if (!stamp) return null;
  const parts = stamp.match(LINE_TS_PARTS);
  if (!parts) return null;
  const pad = (v: string): string => v.padStart(2, "0");
  const [, year, month, day, hour, minute, second, millis] = parts;
  // no trailing Z: the log clock is the machine's own local time
  const iso = `${year}-${pad(month!)}-${pad(day!)}T${pad(hour!)}:${minute}:${second}.${millis}`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

/**
 * Every usage record in a chunk of log text. Called with newly appended bytes
 * only (a byte cursor is kept by the caller), so this stays O(new lines).
 */
export const usageFromLogText = (text: string): UsageRecord[] => {
  const records: UsageRecord[] = [];
  /** Last record per "timestamp|step" — the metrics line repairs it. */
  const recent = new Map<string, UsageRecord>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const occurredAt = lineTimestamp(line);
    if (!occurredAt) continue;

    const metrics = line.match(METRICS);
    if (metrics) {
      const step = Number(metrics[1]);
      const durationMs = Number(metrics[2]);
      const prior = recent.get(`${occurredAt}|${step}`);
      if (prior && Number.isFinite(durationMs)) prior.durationMs = durationMs;
      continue;
    }
    if (!line.includes("notifyStepEnd")) continue;
    const block = line.match(USAGE_BLOCK);
    if (!block?.[1]) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(block[1]);
    } catch {
      continue; // a truncated usage block is worth nothing
    }
    const usage = usageTokens(raw);
    if (!usage) continue;
    const stepMatch = line.match(STEP);
    const step = stepMatch ? Number(stepMatch[1]) : null;
    const record: UsageRecord = {
      occurredAt,
      step: Number.isFinite(step ?? Number.NaN) ? step : null,
      requestId: line.match(ID_AFTER("requestId"))?.[1] ?? null,
      messageId: line.match(ID_AFTER("messageId"))?.[1] ?? null,
      agentPrefix: line.match(AGENT_PREFIX)?.[1] ?? null,
      usage,
      durationMs: null,
    };
    records.push(record);
    if (record.step !== null)
      recent.set(`${occurredAt}|${record.step}`, record);
  }
  return records;
};

/** Usage joined to the message that produced it — last write wins. */
export const indexUsageByMessage = (
  records: UsageRecord[],
): Map<string, UsageRecord> => {
  const map = new Map<string, UsageRecord>();
  for (const record of records) {
    if (!record.messageId) continue;
    map.set(record.messageId, record);
  }
  return map;
};

/**
 * Whether an assistant step's usage is still worth waiting for: the log line
 * lands in the same millisecond as the message file, so a short grace is
 * enough — anything longer ships without counts rather than never ships.
 */
export const USAGE_GRACE_MS = 45_000;
