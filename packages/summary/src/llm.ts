/**
 * One call to an OpenAI-compatible chat-completions endpoint — the shape
 * spoken by the big public providers and by internal gateways/vLLM alike.
 * The detailed variant surfaces every failure mode (unreachable, non-ok,
 * odd shape, timeout) as an error string: a summary is a reading aid and a
 * retrospective a visible failure, never a broken capture path.
 *
 * Streaming-first: the call opens an SSE stream so progress is observable
 * while a reasoning model thinks (the spike proved bigmodel's coding
 * endpoint speaks standard SSE), and falls back to one classic
 * non-streaming attempt only when the endpoint explicitly rejected the
 * stream — providers without SSE, gateways that reject `stream_options`,
 * wrong-path typos. Silence (unreachable, no first byte, a stalled
 * stream) fails directly: a retry would just wait twice against an
 * endpoint that is not answering. A stream that already delivered bytes
 * is never retried: that spend is real.
 */
import { joinUrl } from "@slopwatch/events";
import type { TokenUsage } from "@slopwatch/events";

/** The minimal fetch surface the call needs — real `fetch` or a test stub. */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Rolling preview length: the stream's last N chars ride each chunk event. */
export const STREAM_TAIL_CHARS = 200;

/** Stream progress — fired per frame; callers throttle persistence. */
export type ChatProgress = {
  /** first-byte: response headers arrived. chunk: a delta frame parsed. */
  phase: "first-byte" | "chunk";
  /** Cumulative delta size so far (content + reasoning chars). */
  outputChars: number;
  /**
   * chunk only: the stream's last STREAM_TAIL_CHARS chars (reasoning and
   * content combined) — the live preview a dashboard can show while the
   * report is still forming.
   */
  tail?: string;
};

export type ChatOptions = {
  /** OpenAI-compatible base URL, e.g. "https://llm.internal/v1". */
  endpoint: string;
  model: string;
  apiKey: string;
  system: string;
  user: string;
  /**
   * Non-streaming calls: the overall cap. Streaming calls: the idle gap
   * allowed between frames — a stream that keeps flowing is never cut.
   */
  timeoutMs?: number;
  /** Streaming only: how long response headers may take to arrive. */
  firstByteTimeoutMs?: number;
  /** Stream progress signal — fired per frame; the caller throttles. */
  onProgress?: (progress: ChatProgress) => void;
  maxTokens?: number;
  fetchImpl?: FetchLike;
};

/** Default cap on waiting for response headers before trying non-streaming. */
const FIRST_BYTE_TIMEOUT_MS = 120_000;

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

const chatBody = (o: ChatOptions, maxTokens: number, stream: boolean): string =>
  JSON.stringify({
    model: o.model,
    // reasoning models spend completion budget thinking before they
    // answer — 400 truncated the summary outright, and 1024 still let a
    // 13-digest fold burn 1019 reasoning tokens and answer with zero
    // visible content. `max_tokens` (not `max_completion_tokens`) is
    // intentional: OpenAI-compatible gateways/vLLM speak the classic
    // parameter name and reject the newer one.
    max_tokens: maxTokens,
    temperature: 0.2,
    stream,
    // OpenAI extension; providers that reject it fall back to the classic
    // non-streaming attempt (usage then comes from the standard block).
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    messages: [
      { role: "system", content: o.system },
      { role: "user", content: o.user },
    ],
  });

type RawChoiceBody = {
  choices?: {
    message?: { content?: unknown };
    delta?: { content?: unknown; reasoning_content?: unknown };
    finish_reason?: unknown;
  }[];
  usage?: RawUsage;
};

type AttemptResult = {
  text: string | null;
  budgetBlown: boolean;
  usage?: TokenUsage;
  /** HTTP status of a non-ok response — surfaced by the detailed variant. */
  status?: number;
  /** The last attempt's finish_reason, when the body carried one. */
  finishReason?: string;
  /** Transport-level failure (timeout, unreachable, broken stream). */
  error?: string;
  /**
   * The attempt consumed provider work a retry would double-bill: a 200
   * body was read or stream bytes arrived. Non-ok statuses and dead
   * transports leave this false, keeping one classic fallback affordable.
   */
  consumed: boolean;
};

/** The classic JSON answer shape, shared by both transports. */
const jsonAttempt = (body: RawChoiceBody | null): AttemptResult => {
  const choice = body?.choices?.[0];
  const text = choice?.message?.content;
  const clean =
    typeof text === "string" && text.trim().length > 0 ? text.trim() : null;
  return {
    text: clean,
    // an empty answer with finish_reason "length" means the entire budget
    // went to reasoning — a cap problem, not a failed fold
    budgetBlown: clean === null && choice?.finish_reason === "length",
    usage: toTokenUsage(body?.usage),
    finishReason:
      typeof choice?.finish_reason === "string"
        ? choice.finish_reason
        : undefined,
    consumed: true,
  };
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
    body: chatBody(o, maxTokens, false),
    // a fold runs at session idle, so latency is cheap — 20s cut off
    // legitimate reasoning generations mid-flight
    signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
  });
  if (!res.ok)
    return {
      text: null,
      budgetBlown: false,
      status: res.status,
      consumed: false,
    };
  const body = (await res.json().catch(() => null)) as RawChoiceBody | null;
  return jsonAttempt(body);
};

/**
 * The SSE attempt. Aborts when headers take longer than the first-byte cap
 * or frames stop flowing for the idle gap; a stream that keeps producing is
 * never cut. A provider that answers `stream: true` with a plain JSON body
 * (no event-stream content type) is parsed on the classic path instead.
 */
const attemptStream = async (
  o: ChatOptions,
  maxTokens: number,
): Promise<AttemptResult> => {
  const doFetch = o.fetchImpl ?? fetch;
  const onProgress = o.onProgress;
  const idleMs = o.timeoutMs ?? 300_000;
  const firstByteMs = o.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS;
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stalled: string | undefined;
  let headersOk = false;
  let outputChars = 0;
  let tail = "";
  const arm = (ms: number, message: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = message;
      ctrl.abort();
    }, ms);
  };
  try {
    arm(firstByteMs, `no first byte within ${firstByteMs}ms`);
    const res = await doFetch(joinUrl(o.endpoint, "/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${o.apiKey}`,
      },
      body: chatBody(o, maxTokens, true),
      signal: ctrl.signal,
    });
    headersOk = true;
    if (!res.ok)
      return {
        text: null,
        budgetBlown: false,
        status: res.status,
        consumed: false,
      };
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      // provider ignored stream:true — classic JSON body (also the shape
      // of every test stub server)
      const body = (await res.json().catch(() => null)) as RawChoiceBody | null;
      return jsonAttempt(body);
    }
    onProgress?.({ phase: "first-byte", outputChars: 0 });
    arm(idleMs, `no stream activity for ${idleMs}ms`);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let content = "";
    let finishReason: string | undefined;
    let usage: TokenUsage | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm(idleMs, `no stream activity for ${idleMs}ms`);
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        let frame: RawChoiceBody;
        try {
          frame = JSON.parse(payload) as RawChoiceBody;
        } catch {
          continue; // keep-alive comment or a partial frame
        }
        const delta = frame.choices?.[0]?.delta;
        const piece = typeof delta?.content === "string" ? delta.content : "";
        const reasoning =
          typeof delta?.reasoning_content === "string"
            ? delta.reasoning_content
            : "";
        if (piece !== "" || reasoning !== "") {
          content += piece;
          outputChars += piece.length + reasoning.length;
          tail = (tail + piece + reasoning).slice(-STREAM_TAIL_CHARS);
          onProgress?.({ phase: "chunk", outputChars, tail });
        }
        if (typeof frame.choices?.[0]?.finish_reason === "string")
          finishReason = frame.choices[0]!.finish_reason;
        const frameUsage = toTokenUsage(frame.usage);
        if (frameUsage) usage = frameUsage;
      }
    }
    const clean = content.trim().length > 0 ? content.trim() : null;
    return {
      text: clean,
      budgetBlown: clean === null && finishReason === "length",
      usage,
      finishReason,
      consumed: true,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      text: null,
      budgetBlown: false,
      consumed: headersOk,
      error: stalled
        ? `the LLM stream stalled — ${stalled}`
        : outputChars > 0
          ? `the stream broke after ${outputChars} chars: ${message}`
          : transportError(o.timeoutMs, e),
    };
  } finally {
    clearTimeout(timer);
  }
};

export type ChatResult = {
  text: string | null;
  /** Tokens spent across every attempt of this call (retries included). */
  usage?: TokenUsage;
};

export type DetailedChatResult = ChatResult & {
  /**
   * Why the call failed, when it did: non-ok HTTP status, timeout/unreachable
   * transport error, or an empty answer. Null/undefined on success.
   */
  error?: string;
  finishReason?: string;
};

const attemptError = (r: AttemptResult): string =>
  r.error ??
  (r.status !== undefined
    ? `the LLM endpoint responded ${r.status}`
    : `the answer came back empty with finish_reason ${r.finishReason ?? "unknown"}`);

const catchAttempt =
  (o: ChatOptions) =>
  (e: unknown): AttemptResult => ({
    text: null,
    budgetBlown: false,
    consumed: false,
    error: transportError(o.timeoutMs, e),
  });

/** Auth/billing/rate walls — a non-streaming retry lands on the same one. */
const NO_FALLBACK_STATUS = new Set([401, 402, 429]);

/**
 * The one chat call the server makes, with the failure mode visible — a
 * retrospective needs a failed run row that says why, and the summary fold
 * proxy a 502 the listener can log, instead of a silent null.
 *
 * Streaming first (progress is observable while a reasoning model thinks);
 * one classic fallback only when the endpoint explicitly rejected the
 * stream, and the stream retry at four times the cap when reasoning ate
 * the whole budget.
 */
export const chatCompletionDetailed = async (
  o: ChatOptions,
): Promise<DetailedChatResult> => {
  const cap = o.maxTokens ?? 4096;
  const first = await attemptStream(o, cap).catch(catchAttempt(o));
  if (first.text !== null)
    return {
      text: first.text,
      usage: first.usage,
      finishReason: first.finishReason,
    };
  if (first.budgetBlown) {
    // one budget-raising retry when reasoning consumed the whole cap
    const second = await attemptStream(o, cap * 4).catch(catchAttempt(o));
    return {
      text: second.text,
      usage: sumUsage(first.usage, second.usage),
      finishReason: second.finishReason,
      error: second.text !== null ? undefined : attemptError(second),
    };
  }
  if (first.consumed)
    // bytes flowed and produced nothing usable — retrying would double-bill
    return { text: null, usage: first.usage, error: attemptError(first) };
  // Transport-level silence — unreachable, no first byte, a stream that
  // stalled before its first frame. Nothing was consumed, but a classic
  // retry only doubles the wait against an endpoint that is not answering.
  if (first.error !== undefined)
    return { text: null, usage: first.usage, error: attemptError(first) };
  if (first.status !== undefined && NO_FALLBACK_STATUS.has(first.status))
    return { text: null, error: attemptError(first) };
  // The endpoint explicitly rejected the stream (a non-ok status that is
  // not an auth/billing wall): one classic non-streaming attempt, the
  // shape every SSE-less provider and misconfigured path still answers.
  const fallback = await attempt(o, cap).catch(catchAttempt(o));
  if (fallback.text !== null || !fallback.budgetBlown)
    return {
      text: fallback.text,
      usage: fallback.usage,
      finishReason: fallback.finishReason,
      error:
        fallback.error === undefined && fallback.text === null
          ? attemptError(fallback)
          : fallback.error,
    };
  const retry = await attempt(o, cap * 4).catch(catchAttempt(o));
  return {
    text: retry.text,
    usage: sumUsage(fallback.usage, retry.usage),
    finishReason: retry.finishReason,
    error: retry.text !== null ? undefined : attemptError(retry),
  };
};

const transportError = (timeoutMs: number | undefined, e: unknown): string => {
  const message = e instanceof Error ? e.message : String(e);
  const lowered = message.toLowerCase();
  return message.includes("TimeoutError") ||
    message.includes("abort") ||
    lowered.includes("timed out")
    ? `the LLM call timed out after ${timeoutMs ?? 60_000}ms`
    : `the LLM endpoint was unreachable: ${message}`;
};
