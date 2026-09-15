/**
 * Org webhook push (v2 decision 25): finished sessions push a message to one
 * operator-configured bot URL. Delivery is fire-and-forget — a dead webhook
 * must never fail ingest. The body format adapts to the three common bot
 * dialects; anything exotic goes through an adapter service.
 */
import type { NormalEvent } from "@slopwatch/events";
import type { Store } from "./store";

/** The operator-settable keys; everything else is rejected at the API edge. */
export const SETTING_KEYS = [
  "webhook_url",
  "webhook_enabled",
  "webhook_format",
  "raw_ttl_days",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export const WEBHOOK_FORMATS = ["slack", "feishu", "dingtalk"] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export type WebhookConfig = { url: string; format: WebhookFormat };

export const loadWebhookConfig = async (
  store: Pick<Store, "getSetting">,
): Promise<WebhookConfig | null> => {
  const url = await store.getSetting("webhook_url");
  if (!url) return null;
  if ((await store.getSetting("webhook_enabled")) === "false") return null;
  const format = (await store.getSetting("webhook_format")) ?? "slack";
  return (WEBHOOK_FORMATS as readonly string[]).includes(format)
    ? { url, format: format as WebhookFormat }
    : { url, format: "slack" };
};

/** The one message body shape per bot dialect. */
export const webhookBody = (format: WebhookFormat, text: string): unknown => {
  switch (format) {
    case "feishu":
      return { msg_type: "text", content: { text } };
    case "dingtalk":
      return { msgtype: "text", text: { content: text } };
    default:
      return { text };
  }
};

export const sessionEndText = (
  user: string,
  event: {
    agent: string;
    session_id: string;
  },
): string =>
  `slopwatch: ${user} finished a ${event.agent} session (${event.session_id})`;

export const postWebhook = async (
  url: string,
  body: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<void> => {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
};

/**
 * Push one message per session:end in a just-committed batch. Never throws,
 * never blocks the ingest response: every failure is logged and dropped.
 */
export const pushSessionEnds = (
  store: Pick<Store, "getSetting">,
  events: NormalEvent[],
  user: string,
  fetchImpl: typeof fetch = fetch,
  log: (message: string, error: unknown) => void = console.error,
): void => {
  void (async () => {
    try {
      const ends = events.filter(
        (e) => e.kind === "session" && e.event === "end",
      );
      if (ends.length === 0) return;
      const cfg = await loadWebhookConfig(store);
      if (!cfg) return;
      for (const end of ends) {
        try {
          await postWebhook(
            cfg.url,
            webhookBody(cfg.format, sessionEndText(user, end)),
            fetchImpl,
          );
        } catch (e) {
          log("webhook push failed:", e);
        }
      }
    } catch (e) {
      log("webhook push failed:", e);
    }
  })();
};
