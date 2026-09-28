/**
 * The server-side summary fold (decision 28): the listener ships its fold
 * prompt here and the call executes on the caller's own profile LLM
 * credentials — the key never leaves the process, so ADR 0008's write-only
 * rule survives the summary feature's move off the local config file. One
 * run = one chatCompletionDetailed: the per-attempt timeout and the ×4
 * budget-raising retry for reasoning blowouts live here, where the old
 * client-side fold had them.
 */
import type { TokenUsage } from "@slopwatch/events";
import { chatCompletionDetailed, type FetchLike } from "@slopwatch/summary";
import type { Store } from "./store";

/** Per-attempt LLM budget: parity with the old client-side fold call. */
export const SUMMARY_FOLD_TIMEOUT_MS = 60_000;
/** Hard cap on the caller-supplied token budget. */
export const SUMMARY_FOLD_MAX_TOKENS = 16_384;

export type SummaryFold = {
  /** Whether this user has credentials on file (GET /summary/llm). */
  configured: (user: string) => Promise<boolean>;
  /**
   * One fold completion (POST /summary/fold). Returns the text with the
   * model that produced it, or the failure reason for a 502.
   */
  run: (
    user: string,
    req: { system: string; user: string; maxTokens: number },
  ) => Promise<
    | { ok: true; text: string; model: string; usage?: TokenUsage }
    | { ok: false; error: string }
  >;
};

export const createSummaryFold = (
  store: Store,
  {
    fetchImpl,
    timeoutMs = SUMMARY_FOLD_TIMEOUT_MS,
  }: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): SummaryFold => ({
  configured: async (user) => (await store.getLlmConfig(user)) !== null,
  run: async (user, { system, user: prompt, maxTokens }) => {
    const config = await store.getLlmConfig(user);
    if (config === null)
      return { ok: false, error: "no LLM credentials on the profile" };
    const result = await chatCompletionDetailed({
      endpoint: config.endpoint,
      model: config.model,
      apiKey: config.apiKey,
      system,
      user: prompt,
      maxTokens: Math.min(Math.max(1, maxTokens), SUMMARY_FOLD_MAX_TOKENS),
      timeoutMs,
      fetchImpl,
    });
    if (result.text === null)
      return {
        ok: false,
        error: result.error ?? "the LLM returned no content",
      };
    return {
      ok: true,
      text: result.text,
      model: config.model,
      usage: result.usage,
    };
  },
});
