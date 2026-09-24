/**
 * The retrospective runner (ADR 0008): a small in-process FIFO queue — no
 * external broker. The DB row is the durable task state; this queue only
 * choreographs pending → running → completed/failed. A server restart marks
 * orphaned open rows failed (failStaleRetros at boot); nothing is resumed.
 */
import { chatCompletionDetailed, type FetchLike } from "@slopwatch/summary";
import type { Store } from "../store";

/** Server-wide worker pool default: two concurrent LLM calls. */
export const RETRO_CONCURRENCY = 2;
/** Report budget: the retried-on-length pattern the summary fold proved. */
export const RETRO_MAX_OUTPUT_TOKENS = 16_384;
/** One run's LLM call may think for five minutes before being cut off. */
export const RETRO_TIMEOUT_MS = 300_000;

export type RetroQueueOptions = {
  concurrency?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  log?: (message: string, error?: unknown) => void;
};

export type RetroQueue = {
  /** Schedule one pending row for execution; duplicates are ignored. */
  enqueue: (id: number) => void;
  /** Rows waiting for a worker (excludes the ones mid-flight). */
  size: () => number;
};

export const createRetroQueue = (
  store: Store,
  {
    concurrency = RETRO_CONCURRENCY,
    maxOutputTokens = RETRO_MAX_OUTPUT_TOKENS,
    timeoutMs = RETRO_TIMEOUT_MS,
    fetchImpl,
    log = (message, error) =>
      error === undefined
        ? console.log(message)
        : console.error(message, error),
  }: RetroQueueOptions = {},
): RetroQueue => {
  const waiting: number[] = [];
  const queued = new Set<number>();

  const runOne = async (id: number): Promise<void> => {
    const row = await store.getRetro(id);
    if (row === null || row.status !== "pending") return;
    await store.setRetroRunning(id);
    const fail = (error: string) => store.setRetroFailed(id, error);
    try {
      const config = await store.getLlmConfig(row.user_id);
      if (config === null) {
        await fail(
          "the LLM credentials were removed before this run started — configure them on the profile page and rerun",
        );
        return;
      }
      const session = await store.getSession(row.session_id);
      if (session === null) {
        await fail("the session was deleted before this run started");
        return;
      }
      const result = await chatCompletionDetailed({
        endpoint: config.endpoint,
        model: config.model,
        apiKey: config.apiKey,
        system: row.system_snapshot,
        user: row.prompt_snapshot,
        maxTokens: maxOutputTokens,
        timeoutMs,
        fetchImpl,
      });
      if (result.text !== null) {
        const u = result.usage ?? {};
        await store.setRetroCompleted(id, {
          result: result.text,
          model: config.model,
          usage: {
            inputTokens: u.input_tokens,
            outputTokens: u.output_tokens,
            cacheReadTokens: u.cache_read_tokens,
            reasoningTokens: u.reasoning_tokens,
          },
        });
      } else {
        await fail(result.error ?? "the LLM returned no content");
      }
    } catch (e) {
      // Unexpected store/runner errors still surface as a failed run row —
      // a silent row stuck in running would be worse than a visible failure.
      const message = e instanceof Error ? e.message : String(e);
      log(`retrospective run ${id} crashed:`, e);
      await fail(`the runner crashed: ${message}`);
    }
  };

  // One pump owns scheduling: at most `concurrency` runs in flight, each
  // completion immediately pulls the next waiting row.
  let inFlight = 0;
  const pump = (): void => {
    while (inFlight < concurrency && waiting.length > 0) {
      const id = waiting.shift()!;
      queued.delete(id);
      inFlight += 1;
      void runOne(id)
        .catch((e: unknown) => log(`retrospective run ${id} crashed:`, e))
        .finally(() => {
          inFlight -= 1;
          pump();
        });
    }
  };

  return {
    enqueue: (id: number) => {
      if (queued.has(id)) return;
      queued.add(id);
      waiting.push(id);
      log(`retrospective ${id} queued (${waiting.length} waiting)`);
      pump();
    },
    size: () => waiting.length,
  };
};
