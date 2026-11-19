import type { ModelRollupRow } from "../api";
import { estimateCost, priceFor } from "./pricing";

/**
 * v3 decision 35: the model comparison's numbers, aggregated from the
 * model-grain rollups the reader is already allowed to see — org-wide for an
 * admin, their own for a member. An observational comparison of real
 * workloads over one window, not a benchmark: the workload mix is whatever
 * the team actually ran.
 */

export type ModelStats = {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Total tokens per request; null with no requests in the window. */
  tokensPerRequest: number | null;
  /** Window list-price estimate; null while the model is unpriced. */
  costUsd: number | null;
  /** Total tokens per UTC day over the window, oldest → newest. */
  daily: number[];
};

const usageOf = (
  row: ModelRollupRow,
): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} => ({
  input: row.input_tokens,
  output: row.output_tokens,
  cacheRead: row.cache_read_tokens,
  cacheWrite: row.cache_write_tokens,
});

/**
 * One model's window stats. `days` is the window the caller asked the server
 * for — the daily series spans it, absent days at zero, oldest → newest.
 */
export const modelStats = (
  rows: ModelRollupRow[],
  model: string,
  days: number,
  now = new Date(),
): ModelStats | null => {
  const own = rows.filter((row) => row.model === model);
  if (own.length === 0) return null;
  let requests = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let priced = true;
  const byDay = new Map<string, number>();
  for (const row of own) {
    const usage = usageOf(row);
    requests += row.model_requests;
    input += usage.input;
    output += usage.output;
    cacheRead += usage.cacheRead;
    cacheWrite += usage.cacheWrite;
    const dayTotal =
      usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    byDay.set(row.bucket, (byDay.get(row.bucket) ?? 0) + dayTotal);
    const price = priceFor(row.model);
    if (price === null) priced = false;
    else if (row.model_requests > 0)
      cost += estimateCost(
        {
          input_tokens: usage.input,
          output_tokens: usage.output,
          cache_read_tokens: usage.cacheRead,
          cache_write_tokens: usage.cacheWrite,
        },
        price,
      );
  }
  const totalTokens = input + output + cacheRead + cacheWrite;
  return {
    model,
    requests,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens,
    tokensPerRequest: requests > 0 ? totalTokens / requests : null,
    costUsd: priced ? cost : null,
    daily: Array.from({ length: days }, (_, i) => {
      const day = new Date(now.getTime() - (days - 1 - i) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      return byDay.get(day) ?? 0;
    }),
  };
};

/** Models present in the window, heaviest first — the picker's options. */
export const modelsInWindow = (rows: ModelRollupRow[]): string[] => {
  const requests = new Map<string, number>();
  for (const row of rows)
    requests.set(
      row.model,
      (requests.get(row.model) ?? 0) + row.model_requests,
    );
  return [...requests.entries()]
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .map(([model]) => model);
};
