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
  // Anthropic public list prices (claude-code listener traffic).
  {
    match: "claude-sonnet-4-5",
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
];

export type PricingEntry = {
  match: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

/**
 * Exact model-name match first, then the first matching family prefix —
 * case-insensitively, because the same model id arrives in varying case
 * across record types ("GLM-5.3" vs the sidecar's "glm-5.3"); a case miss
 * would poison the whole all-time cost sum as "unpriced".
 */
export const priceFor = (model: string): PricingEntry | null => {
  const key = model.toLowerCase();
  return (
    PRICING.find((p) => p.match.toLowerCase() === key) ??
    PRICING.find((p) => key.startsWith(p.match.toLowerCase())) ??
    null
  );
};

export const estimateCost = (usage: TokenUsage, price: PricingEntry): number =>
  ((usage.input_tokens ?? 0) * price.input +
    (usage.output_tokens ?? 0) * price.output +
    (usage.cache_read_tokens ?? 0) * (price.cacheRead ?? 0) +
    (usage.cache_write_tokens ?? 0) * (price.cacheWrite ?? 0)) /
  1_000_000;
