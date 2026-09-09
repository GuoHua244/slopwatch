import type { TokenUsage } from "@slopwatch/events";

/**
 * Approximate public list prices, USD per million tokens. Estimates only —
 * subscription/plan billing may differ. More specific `match` entries must
 * come first: lookup tries exact matches, then prefix (family) matches in
 * array order. Unknown fields price at zero; unknown models render as "—".
 */
export const PRICING: PricingEntry[] = [
  // Z.ai public list prices, checked 2026-09-09 via web search.
  { match: "GLM-5.3-Flash", input: 0.15, output: 0.5, cacheRead: 0.03 },
  { match: "GLM-5.3", input: 1.4, output: 4.4 },
];

export type PricingEntry = {
  match: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

/** Exact model-name match first, then the first matching family prefix. */
export const priceFor = (model: string): PricingEntry | null =>
  PRICING.find((p) => p.match === model) ??
  PRICING.find((p) => model.startsWith(p.match)) ??
  null;

export const estimateCost = (usage: TokenUsage, price: PricingEntry): number =>
  ((usage.input_tokens ?? 0) * price.input +
    (usage.output_tokens ?? 0) * price.output +
    (usage.cache_read_tokens ?? 0) * (price.cacheRead ?? 0) +
    (usage.cache_write_tokens ?? 0) * (price.cacheWrite ?? 0)) /
  1_000_000;
