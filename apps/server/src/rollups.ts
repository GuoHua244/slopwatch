import type { NormalEvent, TokenUsage } from "@slopwatch/events";

/**
 * Pure bucketing for the decision-18 usage rollups. Buckets are UTC calendar
 * windows computed from the event's machine-side occurred_at, so replayed
 * backlogs land where the work happened, not where the Server happened to be
 * when it arrived.
 */

/** UTC calendar day of an ISO timestamp: "2026-09-11". */
export const utcDay = (occurredAt: string): string =>
  new Date(occurredAt).toISOString().slice(0, 10);

/** UTC calendar hour of an ISO timestamp: "2026-09-11T17". */
export const utcHour = (occurredAt: string): string =>
  new Date(occurredAt).toISOString().slice(0, 13);

/** Model-independent counters (turn starts, tool calls) per UTC day. */
export type FlatDelta = { turns: number; toolCalls: number };

/** Request and token counters for one model inside one bucket. */
export type ModelDelta = {
  modelRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type RollupDeltas = {
  /** day → counters */
  daily: Map<string, FlatDelta>;
  /** hour → counters (v2 decision 27: feeds local-day display re-bucketing) */
  hourly: Map<string, FlatDelta>;
  /** day → model → counters */
  modelDaily: Map<string, Map<string, ModelDelta>>;
  /** hour → model → counters */
  modelHourly: Map<string, Map<string, ModelDelta>>;
};

const bumpFlat = (
  byBucket: Map<string, FlatDelta>,
  bucket: string,
  key: keyof FlatDelta,
): void => {
  const row = byBucket.get(bucket) ?? { turns: 0, toolCalls: 0 };
  row[key] += 1;
  byBucket.set(bucket, row);
};

const emptyModelDelta = (): ModelDelta => ({
  modelRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

const bumpModel = (
  byModel: Map<string, Map<string, ModelDelta>>,
  bucket: string,
  model: string,
  usage: TokenUsage | undefined,
): void => {
  let models = byModel.get(bucket);
  if (!models) {
    models = new Map();
    byModel.set(bucket, models);
  }
  const row = models.get(model) ?? emptyModelDelta();
  row.modelRequests += 1;
  row.inputTokens += usage?.input_tokens ?? 0;
  row.outputTokens += usage?.output_tokens ?? 0;
  row.cacheReadTokens += usage?.cache_read_tokens ?? 0;
  row.cacheWriteTokens += usage?.cache_write_tokens ?? 0;
  models.set(model, row);
};

/**
 * Reduce a batch into per-bucket deltas. Only events that carry a count are
 * represented: turn starts, tool calls, and model requests. Every appended
 * event is new (the seq allocator has no dedup), so the deltas upsert as-is.
 */
export const rollupDeltas = (events: NormalEvent[]): RollupDeltas => {
  const deltas: RollupDeltas = {
    daily: new Map(),
    hourly: new Map(),
    modelDaily: new Map(),
    modelHourly: new Map(),
  };
  for (const event of events) {
    if (event.kind === "turn" && event.event === "start") {
      bumpFlat(deltas.daily, utcDay(event.occurred_at), "turns");
      bumpFlat(deltas.hourly, utcHour(event.occurred_at), "turns");
    } else if (event.kind === "tool" && event.event === "call") {
      bumpFlat(deltas.daily, utcDay(event.occurred_at), "toolCalls");
      bumpFlat(deltas.hourly, utcHour(event.occurred_at), "toolCalls");
    } else if (event.kind === "model_request") {
      bumpModel(
        deltas.modelDaily,
        utcDay(event.occurred_at),
        event.model,
        event.usage,
      );
      bumpModel(
        deltas.modelHourly,
        utcHour(event.occurred_at),
        event.model,
        event.usage,
      );
    }
  }
  return deltas;
};
