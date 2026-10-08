import {
  foldSummary,
  summaryStore,
  type FoldLlm,
  type SummaryStore,
} from "@slopwatch/summary";
import type { SessionSummaryEvent, TokenUsage } from "@slopwatch/events";

/**
 * One lifetime of the rolling-summary fold, pulled out of the tail skeleton
 * (`live-listener.ts`) so a listener whose capture surface is NOT a
 * line-oriented transcript can reuse it unchanged — the CodeBuddy history is
 * a directory of per-message files, so it drives its own read loop but still
 * wants the same end-of-session fold.
 *
 * Decision 28: the fold's LLM call executes server-side on the caller's own
 * profile credentials, so nothing here holds a key — a user without
 * credentials silently gets no summary, exactly like an install that predates
 * the feature.
 */
export type SummaryFolder = {
  /** The digest store for this session's state base — feed it via the digest. */
  digests: SummaryStore;
  /**
   * Fold the digests accumulated so far. Returns null when nothing could be
   * folded (no server, server unreachable while probing, no credentials, or
   * the LLM returned nothing) — the caller keeps the digests pending so a
   * later end retries them. Never throws: a fold failure costs this end's
   * summary, nothing else.
   */
  fold(): Promise<SessionSummaryEvent | null>;
  /** Whether {@link fold} produced nothing AND there was work left pending. */
  hadPending(): boolean;
};

const cleanUsage = (raw: unknown): TokenUsage | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const usage: TokenUsage = {};
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
  ] as const) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      usage[key] = value;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
};

export const createSummaryFolder = (opts: {
  agent: string;
  sessionId: string;
  /** Listener state path base (cursor minus extension); summaries live beside it. */
  stateBase: string;
  serverUrl?: string;
  token?: string;
  /**
   * Probe `<server>/healthz` before folding so tokens are never spent on a
   * summary that cannot ship. Off for agents whose every end is worth an
   * offline fold (the disk queue preserves it either way).
   */
  probeBeforeFold?: boolean;
}): SummaryFolder => {
  const digests = summaryStore(opts.stateBase);
  const serverBase = opts.serverUrl?.replace(/\/+$/, "");
  const summaryServer =
    serverBase && opts.token
      ? { base: serverBase, token: opts.token }
      : undefined;

  if (!summaryServer) {
    return { digests, fold: async () => null, hadPending: () => false };
  }

  // One fold completion = one server round trip. The server owns the
  // per-attempt LLM timeout and the ×4 budget-raising retry, so the client
  // budget only has to cover both attempts plus the hop.
  const foldLlm: FoldLlm = async ({ system, user, maxTokens }) => {
    try {
      const res = await fetch(`${serverBase}/summary/fold`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${summaryServer.token}`,
        },
        body: JSON.stringify({ system, user, max_tokens: maxTokens }),
        signal: AbortSignal.timeout(150_000),
      });
      if (!res.ok) return { text: null, model: "" };
      const body = (await res.json().catch(() => null)) as {
        text?: unknown;
        model?: unknown;
        usage?: unknown;
      } | null;
      return {
        text:
          typeof body?.text === "string" && body.text.trim().length > 0
            ? body.text.trim()
            : null,
        model: typeof body?.model === "string" ? body.model : "",
        usage: cleanUsage(body?.usage),
      };
    } catch {
      return { text: null, model: "" };
    }
  };

  let pendingReported = false;

  return {
    digests,
    hadPending: () => pendingReported,
    fold: async () => {
      pendingReported = false;
      if (opts.probeBeforeFold) {
        let reachable = false;
        try {
          const res = await fetch(`${serverBase}/healthz`, {
            signal: AbortSignal.timeout(2_500),
          });
          reachable = res.ok;
        } catch {
          reachable = false;
        }
        if (!reachable) {
          // tokens are only spent when the result can actually ship: a fold
          // computed offline is lost with the failed POST and re-burned on
          // the next end
          console.error(
            "live: server unreachable — summary fold skipped, digests kept for retry",
          );
          return null;
        }
      }
      let configured = false;
      try {
        const res = await fetch(`${serverBase}/summary/llm`, {
          headers: { authorization: `Bearer ${summaryServer.token}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as {
            configured?: unknown;
          } | null;
          configured = body?.configured === true;
        }
      } catch {
        configured = false;
      }
      if (!configured) return null;
      const event = await foldSummary({
        stateBase: opts.stateBase,
        agent: opts.agent,
        sessionId: opts.sessionId,
        llm: foldLlm,
      });
      if (!event) {
        pendingReported = digests.pendingDigests().length > 0;
        return null;
      }
      return event;
    },
  };
};
