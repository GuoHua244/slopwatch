/**
 * The rolling fold (open question 15): merge the turn digests added since
 * the last end into the previous summary via one small LLM call. Skips the
 * LLM entirely when nothing new arrived; on LLM failure the digests stay
 * pending so the next end retries them. Every meaningful end leaves the
 * summary current and the last one wins — no need to identify "the real
 * end".
 */
import { SCHEMA_VERSION, type SessionSummaryEvent } from "@slopwatch/events";
import { chatCompletion } from "./llm";
import { summaryStore } from "./store";

export const SYSTEM_PROMPT =
  "You maintain a rolling summary of a coding-agent session for a human " +
  "review dashboard. Merge the new activity into the prior summary and " +
  "reply with ONLY the updated summary: at most 120 words, plain text, in " +
  "the same language as the session's user messages. Cover what was " +
  "attempted, what changed, and whether the work finished.";

export const buildUserPrompt = (
  prior: string | null,
  digests: string[],
): string =>
  `PRIOR SUMMARY:\n${prior ?? "(none — this is the first fold)"}\n\nNEW ACTIVITY:\n${digests
    .map((d) => `- ${d}`)
    .join("\n")}`;

export type FoldOptions = {
  /** Per-session state file base (same base as the sidecar's cursor). */
  stateBase: string;
  agent: string;
  sessionId: string;
  llm: { endpoint: string; model: string; apiKey: string };
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => string;
};

/**
 * Fold pending digests into the rolling summary. Returns the summary event
 * to ship, or null when there was nothing new or the LLM call failed.
 */
export const foldSummary = async (
  opts: FoldOptions,
): Promise<SessionSummaryEvent | null> => {
  const store = summaryStore(opts.stateBase);
  const digests = store.pendingDigests();
  if (digests.length === 0) return null;

  const cache = store.loadCache();
  const text = await chatCompletion({
    ...opts.llm,
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(cache?.body ?? null, digests),
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });
  if (text === null) return null;

  const updatedAt = (opts.now ?? (() => new Date().toISOString()))();
  const model = opts.llm.model;
  store.saveCache({
    body: text,
    model,
    folded: (cache?.folded ?? 0) + digests.length,
    updatedAt,
  });
  store.clearDigests();
  return {
    schema_version: SCHEMA_VERSION,
    agent: opts.agent,
    session_id: opts.sessionId,
    occurred_at: updatedAt,
    kind: "session",
    event: "summary",
    body: text,
    model,
  };
};
