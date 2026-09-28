/**
 * Shared rolling session-summary step (open question 15): both listeners
 * fold new turn digests into the previous summary at each session end and
 * emit a session/summary event. Never throws into the capture path.
 */
export { summaryStore, type SummaryCache, type SummaryStore } from "./store";
export { chatCompletionDetailed, type FetchLike } from "./llm";
export {
  buildUserPrompt,
  FOLD_MAX_TOKENS,
  foldSummary,
  SYSTEM_PROMPT,
  type FoldLlm,
  type FoldOptions,
} from "./summarize";
