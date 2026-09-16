import type { NormalEvent } from "@slopwatch/events";
import type { SummaryStore } from "@slopwatch/summary";

/** "12k in / 3k out" style token tally for a digest line. Sub-10k keeps one
 * decimal so 2499 doesn't round-display as "2k" (a quarter of the truth). */
const fmtTokens = (n: number): string => {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(n / 1000)}k`;
};

export type TurnDigest = {
  /** Append the digest line for the turn in progress, if any. */
  close(): void;
  /** Track turn transitions and request/tool tallies from emitted events. */
  observe(events: NormalEvent[]): void;
};

/**
 * Rolling digest of the turn in progress — appended to the summary log when
 * the turn closes (the next turn starts, or the session ends). Agents without
 * a turn-end record infer completion from turn transitions; a model request
 * seen before the first turn start opens a synthetic turn so its tokens are
 * still captured.
 */
export const createTurnDigest = (summaries: SummaryStore): TurnDigest => {
  let current: {
    user: string;
    requests: number;
    inTokens: number;
    outTokens: number;
    tools: string[];
  } | null = null;
  const open = (user: string) => {
    current = { user, requests: 0, inTokens: 0, outTokens: 0, tools: [] };
    return current;
  };
  const close = (): void => {
    if (!current) return;
    const t = current;
    // cumulative ordinal: everything folded so far plus pending log entries
    const ordinal =
      (summaries.loadCache()?.folded ?? 0) +
      summaries.pendingDigests().length +
      1;
    const parts = [
      `turn ${ordinal}: "${t.user.slice(0, 160)}"`,
      `${t.requests} model request${t.requests === 1 ? "" : "s"} (${fmtTokens(t.inTokens)} in / ${fmtTokens(t.outTokens)} out)`,
      t.tools.length > 0 ? `tools: ${t.tools.join(", ")}` : "",
    ].filter(Boolean);
    summaries.appendDigest(parts.join(" · "));
    current = null;
  };
  const observe = (events: NormalEvent[]): void => {
    for (const e of events) {
      if (e.kind === "turn" && e.event === "start") {
        close();
        open(e.user_message ?? "(no user message text)");
      } else if (e.kind === "model_request") {
        const t = current ?? open("(turn started before capture attached)");
        t.requests += 1;
        t.inTokens += e.usage?.input_tokens ?? 0;
        t.outTokens += e.usage?.output_tokens ?? 0;
      } else if (e.kind === "tool" && e.event === "call") {
        if (current !== null && current.tools.length < 8)
          current.tools.push(e.tool);
      }
    }
  };
  return { close, observe };
};
