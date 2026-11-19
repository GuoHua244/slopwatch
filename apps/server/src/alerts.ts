/**
 * Threshold alerts (v3 decision 33): the ingest path evaluates two
 * admin-configured ceilings after each committed batch — a session burning
 * tokens with zero tool calls at all, and a user's token burn in one UTC
 * hour crossing a spike ceiling. Findings land in the audit log (system
 * actor) and push over the org webhook (v2 decision 25's URL, the same
 * fire-and-forget delivery). Dedup rides the audit log itself: an
 * append-only fact per (action, target), so "already fired" needs no state
 * table and a server restart cannot re-alarm. A threshold of 0 (or absent)
 * switches the check off — an absolute, human-recomputable number, not a
 * baseline statistic.
 */
import type { NormalEvent } from "@slopwatch/events";
import { utcHour } from "./rollups";
import type { Store } from "./store";
import { loadWebhookConfig, postWebhook, webhookBody } from "./webhook";

/**
 * "0" or unset means off; anything else must parse to a positive finite
 * number — a bad value switches the alert off rather than firing garbage.
 */
export const alertThreshold = (raw: string | null): number | null => {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || Number(trimmed) === 0) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export const zeroToolBurnText = (
  user: string,
  sessionId: string,
  tokens: number,
  threshold: number,
): string =>
  `slopwatch alert: ${user}'s session ${sessionId} has burned ${tokens} tokens with zero tool calls (threshold ${threshold})`;

export const hourlySpikeText = (
  user: string,
  hour: string,
  tokens: number,
  threshold: number,
): string =>
  `slopwatch alert: ${user} burned ${tokens} tokens in hour ${hour} UTC (threshold ${threshold})`;

/**
 * The checks themselves, awaitable — tests drive this directly; production
 * goes through `checkAlerts`, which detaches it fire-and-forget.
 */
export const runAlertChecks = async (
  store: Store,
  events: NormalEvent[],
  user: string,
  fetchImpl: typeof fetch = fetch,
  log: (message: string, error: unknown) => void = console.error,
): Promise<void> => {
  try {
    const zero = alertThreshold(
      await store.getSetting("alert_zero_tool_tokens"),
    );
    const hourly = alertThreshold(
      await store.getSetting("alert_hourly_tokens"),
    );
    if ((zero === null && hourly === null) || events.length === 0) return;
    const cfg = await loadWebhookConfig(store);
    if (!cfg) return;

    if (zero !== null) {
      for (const sessionId of new Set(events.map((e) => e.session_id))) {
        try {
          const snap = await store.sessionBurnSnapshot(sessionId);
          if (!snap || snap.toolCalls > 0 || snap.totalTokens < zero) continue;
          if (await store.hasAudit("alert.zero_tool_burn", sessionId)) continue;
          await store.appendAudit({
            actor: { kind: "system" },
            action: "alert.zero_tool_burn",
            target: sessionId,
            detail: {
              user,
              total_tokens: snap.totalTokens,
              threshold: zero,
            },
          });
          await postWebhook(
            cfg.url,
            webhookBody(
              cfg.format,
              zeroToolBurnText(user, sessionId, snap.totalTokens, zero),
            ),
            fetchImpl,
          );
        } catch (e) {
          log("alert push failed:", e);
        }
      }
    }

    if (hourly !== null) {
      for (const hour of new Set(events.map((e) => utcHour(e.occurred_at)))) {
        try {
          const total = await store.hourTokenTotal(user, hour);
          if (total < hourly) continue;
          const target = `${user}/${hour}`;
          if (await store.hasAudit("alert.hourly_spike", target)) continue;
          await store.appendAudit({
            actor: { kind: "system" },
            action: "alert.hourly_spike",
            target,
            detail: { total_tokens: total, threshold: hourly },
          });
          await postWebhook(
            cfg.url,
            webhookBody(cfg.format, hourlySpikeText(user, hour, total, hourly)),
            fetchImpl,
          );
        } catch (e) {
          log("alert push failed:", e);
        }
      }
    }
  } catch (e) {
    log("alert check failed:", e);
  }
};

/**
 * Evaluate both checks against a just-committed batch. Never throws, never
 * blocks the ingest response: every failure is logged and dropped, exactly
 * like the session-end push it sits beside.
 */
export const checkAlerts = (
  store: Store,
  events: NormalEvent[],
  user: string,
  fetchImpl: typeof fetch = fetch,
  log: (message: string, error: unknown) => void = console.error,
): void => {
  void runAlertChecks(store, events, user, fetchImpl, log);
};
