import type { ModelRequestEvent } from "@slopwatch/events";
import type { TurnActivity } from "./timeline";

/**
 * One bar of the session token waterfall (v3 decision 32): a turn's burn,
 * stacked into the four canonical token kinds — the same sums the Usage panel
 * carries, so the strip always reconciles with the session's own totals.
 * Reasoning tokens stay out: they are a detail of output for every provider
 * that reports them, and the rollups never sum them either.
 */
export type WaterfallBar = {
  turnId: string;
  /** The turn's user message, elided — the hover label's first line. */
  label: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  total: number;
};

const elide = (text: string, max = 60): string => {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
};

const sumRequests = (requests: ModelRequestEvent[]) => {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const request of requests) {
    inputTokens += request.usage?.input_tokens ?? 0;
    outputTokens += request.usage?.output_tokens ?? 0;
    cacheReadTokens += request.usage?.cache_read_tokens ?? 0;
    cacheWriteTokens += request.usage?.cache_write_tokens ?? 0;
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
};

/**
 * One bar per turn, in first-appearance order — the same order the turns
 * tab renders. Turns the agent never gave usage (no requests, no turn:end)
 * still take a bar, at zero; requests the timeline could not file under any
 * turn (the timeline's orphans) become a trailing "(unattributed)" bar so
 * the strip's total never silently drops tokens.
 */
export const waterfallBars = (
  turns: TurnActivity[],
  orphanRequests: ModelRequestEvent[] = [],
): WaterfallBar[] => {
  const bars: WaterfallBar[] = turns.map((turn) => {
    const usage = turn.usage ?? {};
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const cacheReadTokens = usage.cache_read_tokens ?? 0;
    const cacheWriteTokens = usage.cache_write_tokens ?? 0;
    return {
      turnId: turn.turnId,
      label: turn.userMessage ? elide(turn.userMessage) : `turn ${turn.turnId}`,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      total: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    };
  });
  const orphans = sumRequests(orphanRequests);
  if (
    orphans.inputTokens +
      orphans.outputTokens +
      orphans.cacheReadTokens +
      orphans.cacheWriteTokens >
    0
  ) {
    bars.push({
      turnId: "(unattributed)",
      label: "requests the timeline could not file under a turn",
      ...orphans,
      total:
        orphans.inputTokens +
        orphans.outputTokens +
        orphans.cacheReadTokens +
        orphans.cacheWriteTokens,
    });
  }
  return bars;
};

/** Total burn across the strip — the "(unattributed)" bar included. */
export const waterfallTotal = (bars: WaterfallBar[]): number =>
  bars.reduce((sum, bar) => sum + bar.total, 0);
