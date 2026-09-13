import { describe, expect, test } from "bun:test";
import { createApp, type App } from "./http";
import type { NormalEvent, SessionEndEvent } from "@slopwatch/events";
import {
  loadWebhookConfig,
  postWebhook,
  pushSessionEnds,
  sessionEndText,
  webhookBody,
} from "./webhook";
import type { Store } from "./store";

const end = (sessionId: string): SessionEndEvent => ({
  schema_version: 1,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: "2026-09-13T00:00:00.000Z",
  kind: "session",
  event: "end",
  reason: "normal",
});

describe("webhook body formats (decision 25)", () => {
  test("slack default, feishu, dingtalk", () => {
    expect(webhookBody("slack", "hi")).toEqual({ text: "hi" });
    expect(webhookBody("feishu", "hi")).toEqual({
      msg_type: "text",
      content: { text: "hi" },
    });
    expect(webhookBody("dingtalk", "hi")).toEqual({
      msgtype: "text",
      text: { content: "hi" },
    });
  });

  test("session end message names the user, agent, and session", () => {
    expect(sessionEndText("alice", end("sess_x"))).toBe(
      "slopwatch: alice finished a zcode session (sess_x)",
    );
  });
});

describe("loadWebhookConfig", () => {
  const settingsStore = (
    values: Record<string, string>,
  ): Pick<Store, "getSetting"> => ({
    getSetting: async (key) => values[key] ?? null,
  });

  test("no url configured → null", async () => {
    expect(await loadWebhookConfig(settingsStore({}))).toBeNull();
  });
  test("disabled beats configured", async () => {
    const cfg = await loadWebhookConfig(
      settingsStore({ webhook_url: "http://x", webhook_enabled: "false" }),
    );
    expect(cfg).toBeNull();
  });
  test("unknown format falls back to slack", async () => {
    const cfg = await loadWebhookConfig(
      settingsStore({
        webhook_url: "http://x",
        webhook_format: "carrier-pigeon",
      }),
    );
    expect(cfg).toEqual({ url: "http://x", format: "slack" });
  });
});

describe("postWebhook", () => {
  test("non-2xx is an error; 2xx resolves", async () => {
    await expect(
      postWebhook(
        "http://x",
        { text: "t" },
        (async () =>
          new Response("nope", { status: 500 })) as unknown as typeof fetch,
      ),
    ).rejects.toThrow("webhook responded 500");
    let seenBody: unknown;
    await postWebhook("http://x", { text: "t" }, (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response("ok");
    }) as typeof fetch);
    expect(seenBody).toEqual({ text: "t" });
  });
});

describe("pushSessionEnds over HTTP", () => {
  test("a finished session pushes one message to the configured webhook", async () => {
    const received: unknown[] = [];
    const webhookServer = Bun.serve({
      port: 0,
      fetch: async (req) => {
        received.push(await req.json());
        return Response.json({ ok: true });
      },
    });
    try {
      // minimal scripted store: settings + a no-op append; nothing else touched
      const store = {
        appendEvents: async () => ({ accepted: 1 }),
        getSetting: async (key: string) =>
          key === "webhook_url"
            ? `http://127.0.0.1:${webhookServer.port}`
            : null,
        setSetting: async () => {},
        clearSetting: async () => {},
        listSettings: async () => ({}),
      } as unknown as Store;
      const app: App = createApp({
        tokens: new Map([["tok-alice", "alice"]]),
        adminToken: "admin-tok",
        store,
      });
      const batch: NormalEvent[] = [end("sess_push-1")];
      const res = await app.fetch(
        new Request("http://x/events", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer tok-alice",
          },
          body: JSON.stringify({ schema_version: 1, events: batch }),
        }),
      );
      expect(res.status).toBe(202);
      // the push is fire-and-forget — poll briefly for delivery
      for (let i = 0; i < 40 && received.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(received).toEqual([
        { text: "slopwatch: alice finished a zcode session (sess_push-1)" },
      ]);
    } finally {
      webhookServer.stop(true);
    }
  }, 15_000);
});
