/**
 * The rolling fold (open question 15): merge the turn digests added since
 * the last end into the previous summary via one small LLM call. Skips the
 * LLM entirely when nothing new arrived; on LLM failure the digests stay
 * pending so the next end retries them. After a successful fold exactly the
 * folded snapshot is consumed — digests appended while the LLM call was in
 * flight stay pending for the next fold instead of being deleted unfolded.
 * Every meaningful end leaves the summary current and the last one wins —
 * no need to identify "the real end".
 */
import { envelope, type SessionSummaryEvent } from "@slopwatch/events";
import { chatCompletion } from "./llm";
import { summaryStore } from "./store";

export const SYSTEM_PROMPT =
  "You maintain a rolling summary of a coding-agent session for a human " +
  "review dashboard. Merge the new activity into the prior summary and " +
  "reply with ONLY the updated summary: at most 120 words, plain text, in " +
  "the same language as the session's user messages. Cover what was " +
  "attempted, what changed, and whether the work finished.";

/**
 * Byte budget for the digest block of one fold prompt. A backlog that
 * outgrows it folds the oldest digests first (start of the pending list, so
 * chronology is preserved); the rest stay pending for the next fold.
 */
export const MAX_FOLD_DIGEST_BYTES = 32_000;

const digestLineBytes = (digest: string): number =>
  Buffer.byteLength(`- ${digest}\n`, "utf8");

export const buildUserPrompt = (
  prior: string | null,
  digests: string[],
): string =>
  `PRIOR SUMMARY:\n${prior ?? "(none — this is the first fold)"}\n\nNEW ACTIVITY:\n${digests
    .map((d) => `- ${d}`)
    .join("\n")}`;

export type FoldOptions = {
  /** Per-session state file base (same base as the listener's cursor). */
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

  // Cap the prompt: take the oldest digests first until the byte budget is
  // full (always admitting at least one so a fold can never stall), and
  // leave the overflow pending for the next fold.
  const folded: string[] = [];
  let bytes = 0;
  for (const digest of digests) {
    const cost = digestLineBytes(digest);
    if (folded.length > 0 && bytes + cost > MAX_FOLD_DIGEST_BYTES) break;
    folded.push(digest);
    bytes += cost;
  }
  if (folded.length < digests.length) {
    console.error(
      `slopwatch summary: fold prompt capped at ${MAX_FOLD_DIGEST_BYTES} bytes ` +
        `— folding ${folded.length} of ${digests.length} pending digests; ` +
        `${digests.length - folded.length} left for the next fold`,
    );
  }

  const cache = store.loadCache();
  const text = await chatCompletion({
    ...opts.llm,
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(cache?.body ?? null, folded),
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });
  if (text === null) return null;

  const updatedAt = (opts.now ?? (() => new Date().toISOString()))();
  const model = opts.llm.model;
  store.saveCache({
    body: text,
    model,
    folded: (cache?.folded ?? 0) + folded.length,
    updatedAt,
  });
  // Consume exactly what was folded: the digest log may have grown while the
  // LLM call ran, and those newer entries must survive.
  store.consumeDigests(folded.length);
  return {
    ...envelope(opts.agent, opts.sessionId, updatedAt),
    kind: "session",
    event: "summary",
    body: text,
    model,
  };
};
