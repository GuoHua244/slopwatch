/**
 * Shared rolling session-summary step (open question 15): both listeners
 * fold new turn digests into the previous summary at each session end and
 * emit a session/summary event. Never throws into the capture path.
 */
export { summaryStore, type SummaryCache, type SummaryStore } from "./store";
export { chatCompletion, chatCompletionDetailed, type FetchLike } from "./llm";
export {
  buildUserPrompt,
  foldSummary,
  SYSTEM_PROMPT,
  type FoldOptions,
} from "./summarize";
