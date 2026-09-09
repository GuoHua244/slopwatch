import type { StoredEvent } from "../api";
import { estimateCost, priceFor } from "./pricing";

export type ModelUsage = {
  model: string;
  provider: string;
  requests: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** List-price estimate; null when the model has no pricing entry. */
  costUsd: number | null;
};

export type SessionTotals = {
  requests: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** null unless every request's model has a pricing entry. */
  costUsd: number | null;
};

const emptyUsage = (model: string, provider: string): ModelUsage => ({
  model,
  provider,
  requests: 0,
  durationMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: null,
});

/** Per-model rollup over one session's model_request events. */
export const modelBreakdown = (events: StoredEvent[]): ModelUsage[] => {
  const byModel = new Map<string, ModelUsage>();
  for (const { event } of events) {
    if (event.kind !== "model_request") continue;
    let row = byModel.get(event.model);
    if (!row) {
      row = emptyUsage(event.model, event.provider);
      byModel.set(event.model, row);
    }
    row.requests += 1;
    row.durationMs += event.duration_ms;
    row.inputTokens += event.usage?.input_tokens ?? 0;
    row.outputTokens += event.usage?.output_tokens ?? 0;
    row.cacheReadTokens += event.usage?.cache_read_tokens ?? 0;
    row.cacheWriteTokens += event.usage?.cache_write_tokens ?? 0;
    const price = priceFor(event.model);
    row.costUsd =
      price === null
        ? null
        : (row.costUsd ?? 0) + estimateCost(event.usage ?? {}, price);
  }
  // Priced models by spend first; unpriced models trail alphabetically.
  return [...byModel.values()].sort((a, b) => {
    if (a.costUsd === null && b.costUsd === null)
      return a.model.localeCompare(b.model);
    if (a.costUsd === null) return 1;
    if (b.costUsd === null) return -1;
    return b.costUsd - a.costUsd;
  });
};

/** Whole-session rollup; cost needs every contributing model to be priced. */
export const sessionTotals = (events: StoredEvent[]): SessionTotals => {
  const totals: SessionTotals = {
    requests: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
  };
  let cost = 0;
  let allPriced = true;
  for (const { event } of events) {
    if (event.kind !== "model_request") continue;
    totals.requests += 1;
    totals.durationMs += event.duration_ms;
    totals.inputTokens += event.usage?.input_tokens ?? 0;
    totals.outputTokens += event.usage?.output_tokens ?? 0;
    totals.cacheReadTokens += event.usage?.cache_read_tokens ?? 0;
    totals.cacheWriteTokens += event.usage?.cache_write_tokens ?? 0;
    const price = priceFor(event.model);
    if (price === null) allPriced = false;
    else cost += estimateCost(event.usage ?? {}, price);
  }
  totals.costUsd = allPriced && totals.requests > 0 ? cost : null;
  return totals;
};
