/**
 * One call to an OpenAI-compatible chat-completions endpoint — the shape
 * spoken by the big public providers and by internal gateways/vLLM alike.
 * Every failure mode (unreachable, non-ok, odd shape, timeout) collapses to
 * null: a summary is a reading aid and must never break the capture path.
 */
export type ChatOptions = {
  /** OpenAI-compatible base URL, e.g. "https://llm.internal/v1". */
  endpoint: string;
  model: string;
  apiKey: string;
  system: string;
  user: string;
  timeoutMs?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
};

type AttemptResult = { text: string | null; budgetBlown: boolean };

const attempt = async (
  o: ChatOptions,
  maxTokens: number,
): Promise<AttemptResult> => {
  const doFetch = o.fetchImpl ?? fetch;
  const res = await doFetch(
    `${o.endpoint.replace(/\/+$/, "")}/chat/completions`,
    {
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
        // visible content
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
    },
  );
  if (!res.ok) return { text: null, budgetBlown: false };
  const body = (await res.json().catch(() => null)) as {
    choices?: {
      message?: { content?: unknown };
      finish_reason?: unknown;
    }[];
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
  };
};

export const chatCompletion = async (
  o: ChatOptions,
): Promise<string | null> => {
  try {
    const first = await attempt(o, o.maxTokens ?? 4096);
    if (first.text !== null || !first.budgetBlown) return first.text;
    // null leaves the digests pending, so every later fold retries them and
    // gets heavier — without a higher-cap retry a blowout repeats forever
    return (await attempt(o, (o.maxTokens ?? 4096) * 4)).text;
  } catch {
    return null;
  }
};
