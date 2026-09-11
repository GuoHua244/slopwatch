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

export const chatCompletion = async (
  o: ChatOptions,
): Promise<string | null> => {
  try {
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
          // answer — 400 left a truncated summary after ~370 reasoning tokens
          max_tokens: o.maxTokens ?? 1024,
          temperature: 0.2,
          messages: [
            { role: "system", content: o.system },
            { role: "user", content: o.user },
          ],
        }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
      },
    );
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: unknown } }[];
    } | null;
    const text = body?.choices?.[0]?.message?.content;
    return typeof text === "string" && text.trim().length > 0
      ? text.trim()
      : null;
  } catch {
    return null;
  }
};
