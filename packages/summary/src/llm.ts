/**
 * One call to an OpenAI-compatible chat-completions endpoint — the shape
 * spoken by the big public providers and by internal gateways/vLLM alike.
 * Every failure mode (unreachable, non-ok, odd shape, timeout) collapses to
 * null: a summary is a reading aid and must never break the capture path.
 */
import { joinUrl } from "@slopwatch/events";
import type { TokenUsage } from "@slopwatch/events";

/** The minimal fetch surface the call needs — real `fetch` or a test stub. */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ChatOptions = {
  /** OpenAI-compatible base URL, e.g. "https://llm.internal/v1". */
  endpoint: string;
  model: string;
  apiKey: string;
  system: string;
  user: string;
  timeoutMs?: number;
  maxTokens?: number;
  fetchImpl?: FetchLike;
};

/**
 * The response's `usage` block mapped into the canonical TokenUsage fields.
 * OpenAI semantics: cached and reasoning tokens are subsets of the prompt and
 * completion counts, not additive. Gateways vary in what they report — every
 * field is optional and only clean non-negative integers survive.
 */
type RawUsage = {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown };
  completion_tokens_details?: { reasoning_tokens?: unknown };
};

const cleanCount = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;

const toTokenUsage = (
  raw: RawUsage | undefined | null,
): TokenUsage | undefined => {
  if (!raw) return undefined;
  const usage: TokenUsage = {};
  const input = cleanCount(raw.prompt_tokens);
  const output = cleanCount(raw.completion_tokens);
  const cacheRead = cleanCount(raw.prompt_tokens_details?.cached_tokens);
  const reasoning = cleanCount(raw.completion_tokens_details?.reasoning_tokens);
  if (input !== undefined) usage.input_tokens = input;
  if (output !== undefined) usage.output_tokens = output;
  if (cacheRead !== undefined) usage.cache_read_tokens = cacheRead;
  if (reasoning !== undefined) usage.reasoning_tokens = reasoning;
  return Object.keys(usage).length > 0 ? usage : undefined;
};

const sumUsage = (a: TokenUsage | undefined, b: TokenUsage | undefined) => {
  if (!a) return b;
  if (!b) return a;
  const keys = [
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
  ] as const;
  const out: TokenUsage = {};
  for (const key of keys) {
    const total = (a[key] ?? 0) + (b[key] ?? 0);
    if (total > 0) out[key] = total;
  }
  return out;
};

type AttemptResult = {
  text: string | null;
  budgetBlown: boolean;
  usage?: TokenUsage;
  /** HTTP status of a non-ok response — surfaced by the detailed variant. */
  status?: number;
  /** The last attempt's finish_reason, when the body carried one. */
  finishReason?: string;
  /** Transport-level failure (timeout, unreachable) from the catch path. */
  error?: string;
};

const attempt = async (
  o: ChatOptions,
  maxTokens: number,
): Promise<AttemptResult> => {
  const doFetch = o.fetchImpl ?? fetch;
  const res = await doFetch(joinUrl(o.endpoint, "/chat/completions"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${o.apiKey}`,
    },
    body: JSON.stringify({
      model: o.model,
      // reasoning models spend completion budget thinking before they
      // answer — 400 truncated the summary outright, and 1024 still let a
      // 13-digest fold burn 1019 reasoning tokens and answer with zero
      // visible content. `max_tokens` (not `max_completion_tokens`) is
      // intentional: OpenAI-compatible gateways/vLLM speak the classic
      // parameter name and reject the newer one.
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [
        { role: "system", content: o.system },
        { role: "user", content: o.user },
      ],
    }),
    // a fold runs at session idle, so latency is cheap — 20s cut off
    // legitimate reasoning generations mid-flight
    signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
  });
  if (!res.ok) return { text: null, budgetBlown: false, status: res.status };
  const body = (await res.json().catch(() => null)) as {
    choices?: {
      message?: { content?: unknown };
      finish_reason?: unknown;
    }[];
    usage?: RawUsage;
  } | null;
  const choice = body?.choices?.[0];
  const text = choice?.message?.content;
  const clean =
    typeof text === "string" && text.trim().length > 0 ? text.trim() : null;
  return {
    text: clean,
    // an empty answer with finish_reason "length" means the entire budget
    // went to reasoning — a cap problem, not a failed fold
    budgetBlown: clean === null && choice?.finish_reason === "length",
    // a budget-blown attempt still burned tokens — counted by the caller
    usage: toTokenUsage(body?.usage),
    finishReason:
      typeof choice?.finish_reason === "string"
        ? choice.finish_reason
        : undefined,
  };
};

export type ChatResult = {
  text: string | null;
  /** Tokens spent across every attempt of this call (retries included). */
  usage?: TokenUsage;
};

export const chatCompletion = async (o: ChatOptions): Promise<ChatResult> => {
  try {
    const first = await attempt(o, o.maxTokens ?? 4096);
    if (first.text !== null || !first.budgetBlown)
      return { text: first.text, usage: first.usage };
    // null leaves the digests pending, so every later fold retries them and
    // gets heavier — without a higher-cap retry a blowout repeats forever
    const second = await attempt(o, (o.maxTokens ?? 4096) * 4);
    return {
      text: second.text,
      usage: sumUsage(first.usage, second.usage),
    };
  } catch {
    return { text: null };
  }
};

export type DetailedChatResult = ChatResult & {
  /**
   * Why the call failed, when it did: non-ok HTTP status, timeout/unreachable
   * transport error, or an empty answer. Null/undefined on success.
   */
  error?: string;
  finishReason?: string;
};

/**
 * The same call as chatCompletion but with the failure mode visible — the
 * server-side retrospective needs a failed run row that says why, where the
 * summary's contract is to collapse every failure to null.
 */
export const chatCompletionDetailed = async (
  o: ChatOptions,
): Promise<DetailedChatResult> => {
  const first = await attempt(o, o.maxTokens ?? 4096).catch(
    (e: unknown): AttemptResult => ({
      text: null,
      budgetBlown: false,
      error: transportError(o.timeoutMs, e),
    }),
  );
  if (first.text !== null || !first.budgetBlown)
    return {
      text: first.text,
      usage: first.usage,
      finishReason: first.finishReason,
      error:
        first.error ??
        (first.text !== null
          ? undefined
          : first.status !== undefined
            ? `the LLM endpoint responded ${first.status}`
            : "the LLM endpoint returned no answer content"),
    };
  // one budget-raising retry when reasoning consumed the whole cap
  const second = await attempt(o, (o.maxTokens ?? 4096) * 4).catch(
    (e: unknown): AttemptResult => ({
      text: null,
      budgetBlown: false,
      error: transportError(o.timeoutMs, e),
    }),
  );
  return {
    text: second.text,
    usage: sumUsage(first.usage, second.usage),
    finishReason: second.finishReason,
    error:
      second.text !== null
        ? undefined
        : (second.error ??
          (second.status !== undefined
            ? `the LLM endpoint responded ${second.status}`
            : `the answer came back empty with finish_reason ${second.finishReason ?? "unknown"}`)),
  };
};

const transportError = (timeoutMs: number | undefined, e: unknown): string => {
  const message = e instanceof Error ? e.message : String(e);
  return message.includes("TimeoutError") || message.includes("abort")
    ? `the LLM call timed out after ${timeoutMs ?? 60_000}ms`
    : `the LLM endpoint was unreachable: ${message}`;
};
