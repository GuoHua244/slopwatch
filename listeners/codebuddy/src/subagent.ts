/**
 * Sub-agent runs, read off the agent log.
 *
 * Measured 2026-10-09 (research/codebuddy-capture-surfaces.md §5): a `Task`
 * tool call starts a SECOND `BaseAgent:<type>` run — a different agent type
 * and its own `requestId`, which is that run's id:
 *
 *   [2026/10/9 12:21:29.062] [Info] [BaseAgent:craft] [d149dd4c…]  notifyAgentStart
 *   [2026/10/9 12:21:50.539] [Info] [BaseAgent:code-explorer] [c09d2e05…]  notifyAgentStart
 *   [2026/10/9 12:22:00.174] [Info] [BaseAgent:code-explorer] [c09d2e05…]  notifyStepEnd, step: 1, requestId: c09d2e05…, messageId: 8c0fbe43…, usage: {…}
 *
 * The sub-agent's messages never reach the parent conversation's manifest
 * (no child conversation directory is created at all), so its tool calls and
 * its prose are unrecoverable — but its tokens are not, and tokens are what
 * Slopwatch attributes. Each run therefore ships as a child Session
 * (`parent_session_id`, ADR 0008) carrying its model requests, exactly the
 * shape ZCode's subagent rollout files produce.
 *
 * Open ends: the host logs no `notifyAgentEnd`, so a run ends on idleness or
 * when this listener ends — never on a signal that does not exist.
 */
import type { TokenUsage } from "@slopwatch/events";

export type AgentRun = {
  /** The run's `requestId` — constant across its steps, unique per run. */
  runId: string;
  /** The `BaseAgent:<type>` prefix: the sub-agent's kind, e.g. code-explorer. */
  agentType: string;
  startedAt: string;
};

const AGENT_PREFIX = /\[BaseAgent:([^\]]+)\]/;
const BRACKETED_ID = /\[([0-9a-fA-F-]{8,})\]/;
const MODEL_ID = /\bmodelId:\s*([\w.@:-]+)/;
const LINE_TS = /^\[(\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}\.\d{3})\]/;
const LINE_TS_PARTS =
  /^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})\.(\d{3})$/;

export const agentPrefixOf = (line: string): string | null =>
  line.match(AGENT_PREFIX)?.[1] ?? null;

/** The id in the bracket that follows the agent prefix — i.e. the run id. */
export const runIdOf = (line: string): string | null => {
  const after = line.replace(AGENT_PREFIX, "");
  return after.match(BRACKETED_ID)?.[1] ?? null;
};

const isoFromStamp = (stamp: string): string | null => {
  const parts = stamp.match(LINE_TS_PARTS);
  if (!parts) return null;
  const pad = (v: string): string => v.padStart(2, "0");
  const [, year, month, day, hour, minute, second, millis] = parts;
  const parsed = new Date(
    `${year}-${pad(month!)}-${pad(day!)}T${pad(hour!)}:${minute}:${second}.${millis}`,
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

/**
 * Every `notifyAgentStart` in a chunk of log text. The main agent's own run
 * is included — the caller decides which runs are children.
 */
export const parseAgentRuns = (text: string): AgentRun[] => {
  const runs: AgentRun[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("notifyAgentStart")) continue;
    const agentType = agentPrefixOf(line);
    const runId = runIdOf(line);
    if (!agentType || !runId) continue;
    const stamp = line.match(LINE_TS)?.[1];
    const startedAt = stamp ? isoFromStamp(stamp) : null;
    if (!startedAt) continue;
    runs.push({ runId, agentType, startedAt });
  }
  return runs;
};

/** Model id per agent type, from each agent's provider-init line. */
export const modelByPrefix = (text: string): Map<string, string> => {
  const models = new Map<string, string>();
  for (const line of text.split("\n")) {
    const prefix = agentPrefixOf(line);
    const model = line.match(MODEL_ID)?.[1];
    if (prefix && model) models.set(prefix, model);
  }
  return models;
};

/**
 * A run is a child unless its id is one of the parent conversation's own
 * request ids (read from the parent's message files) — the parent's run is
 * never a sub-agent of itself.
 */
export const isChildRun = (
  run: AgentRun,
  parentRunIds: ReadonlySet<string>,
): boolean => !parentRunIds.has(run.runId);

export const childSessionId = (runId: string): string => `sub-${runId}`;

/**
 * How long a run may go quiet before it is closed. Steps land seconds apart
 * while a sub-agent works, so this is generous — and bounded, because an
 * open child session never contributes to a total otherwise.
 */
export const CHILD_IDLE_MS = 120_000;

export type ChildStep = {
  occurredAt: string;
  usage: TokenUsage;
  durationMs: number | null;
  requestId: string | null;
};
