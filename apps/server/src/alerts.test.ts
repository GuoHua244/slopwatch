import { describe, expect, test } from "bun:test";
import {
  SCHEMA_VERSION,
  type ModelRequestEvent,
  type NormalEvent,
  type SessionStartEvent,
} from "@slopwatch/events";
import {
  alertThreshold,
  hourlySpikeText,
  zeroToolBurnText,
  runAlertChecks,
} from "./alerts";

describe("alert thresholds and texts (v3 decision 33)", () => {
  test("0, blank, absent, and garbage switch the check off", () => {
    expect(alertThreshold(null)).toBeNull();
    expect(alertThreshold("")).toBeNull();
    expect(alertThreshold("  ")).toBeNull();
    expect(alertThreshold("0")).toBeNull();
    expect(alertThreshold("nope")).toBeNull();
    expect(alertThreshold("-5")).toBeNull();
  });

  test("a positive number arms the ceiling", () => {
    expect(alertThreshold("1000")).toBe(1000);
    expect(alertThreshold(" 2.5e3 ")).toBe(2500);
  });

  test("the two message shapes name the facts", () => {
    expect(zeroToolBurnText("alice", "sess_1", 42_000, 10_000)).toBe(
      "slopwatch alert: alice's session sess_1 has burned 42000 tokens with zero tool calls (threshold 10000)",
    );
    expect(hourlySpikeText("bob", "2026-09-11T17", 900_000, 500_000)).toBe(
      "slopwatch alert: bob burned 900000 tokens in hour 2026-09-11T17 UTC (threshold 500000)",
    );
  });
});

// --- Postgres-backed end-to-end: ingest → check → audit dedup → webhook ---

const dbTests = () =>
  (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL) !== undefined;
const testDsn = () =>
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!;

const modelRequest = (
  sessionId: string,
  usage: { input_tokens: number; output_tokens: number },
): ModelRequestEvent => ({
  schema_version: SCHEMA_VERSION,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: "2026-09-11T17:30:00Z",
  kind: "model_request",
  provider: "p",
  model: "m1",
  duration_ms: 5,
  usage,
});

const sessionStart = (sessionId: string): SessionStartEvent => ({
  schema_version: SCHEMA_VERSION,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: "2026-09-11T17:29:00Z",
  kind: "session",
  event: "start",
  cwd: "D:\\demo",
  hostname: "DEV-01",
});

describe.skipIf(!dbTests())("alert checks against Postgres", () => {
  let store: import("./store").Store | undefined;
  const ensure = async () => {
    if (store) return;
    const { createPgStore } = await import("./store");
    store = createPgStore(testDsn());
    await store.migrate();
  };

  /** Capture webhook deliveries; 204 answers keep postWebhook happy. */
  const recorder = () => {
    const posts: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      posts.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    return { posts, fetchImpl };
  };

  test("zero-tool burn fires once, audits, and pushes; a tool call disarms it", async () => {
    await ensure();
    const user = `alert-${crypto.randomUUID().slice(0, 8)}`;
    const sid = `sess_alert-${crypto.randomUUID().slice(0, 8)}`;
    await store!.setSetting("webhook_url", "https://hooks.example/x");
    await store!.setSetting("alert_zero_tool_tokens", "1000");
    await store!.setSetting("alert_hourly_tokens", "");
    const { posts, fetchImpl } = recorder();

    await store!.appendEvents(
      [
        sessionStart(sid),
        modelRequest(sid, {
          input_tokens: 1500,
          output_tokens: 500,
        }),
      ],
      user,
    );
    await runAlertChecks(
      store!,
      [modelRequest(sid, { input_tokens: 1, output_tokens: 1 })],
      user,
      fetchImpl,
    );

    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://hooks.example/x");
    expect((posts[0]!.body as { text: string }).text).toContain(
      "zero tool calls",
    );
    expect(await store!.hasAudit("alert.zero_tool_burn", sid)).toBe(true);

    // The audit fact dedups: a second check on the same session is silent.
    await runAlertChecks(
      store!,
      [modelRequest(sid, { input_tokens: 1, output_tokens: 1 })],
      user,
      fetchImpl,
    );
    expect(posts).toHaveLength(1);

    // A different session with the same burn alarms on its own.
    const sid2 = `sess_alert-${crypto.randomUUID().slice(0, 8)}`;
    await store!.appendEvents(
      [
        sessionStart(sid2),
        modelRequest(sid2, {
          input_tokens: 1500,
          output_tokens: 500,
        }),
      ],
      user,
    );
    await runAlertChecks(
      store!,
      [modelRequest(sid2, { input_tokens: 1, output_tokens: 1 })],
      user,
      fetchImpl,
    );
    expect(posts).toHaveLength(2);

    // But a session that made tool calls never alarms, whatever the burn.
    const sid3 = `sess_alert-${crypto.randomUUID().slice(0, 8)}`;
    const withTool: NormalEvent[] = [
      sessionStart(sid3),
      modelRequest(sid3, { input_tokens: 900_000, output_tokens: 10 }),
      {
        schema_version: SCHEMA_VERSION,
        agent: "zcode",
        session_id: sid3,
        occurred_at: "2026-09-11T17:31:00Z",
        kind: "tool",
        event: "call",
        tool_call_id: "c1",
        tool: "Bash",
      },
    ];
    await store!.appendEvents(withTool, user);
    await runAlertChecks(store!, withTool, user, fetchImpl);
    expect(posts).toHaveLength(2);
  });

  test("hourly spike fires per user-hour once, from the rollup totals", async () => {
    await ensure();
    const user = `alert-${crypto.randomUUID().slice(0, 8)}`;
    const sid = `sess_alert-${crypto.randomUUID().slice(0, 8)}`;
    await store!.setSetting("webhook_url", "https://hooks.example/x");
    await store!.setSetting("alert_zero_tool_tokens", "");
    await store!.setSetting("alert_hourly_tokens", "100");
    const { posts, fetchImpl } = recorder();

    // Two requests in the same UTC hour accumulate through the rollup.
    await store!.appendEvents(
      [
        modelRequest(sid, { input_tokens: 60, output_tokens: 30 }),
        modelRequest(sid, { input_tokens: 20, output_tokens: 10 }),
      ],
      user,
    );
    await runAlertChecks(
      store!,
      [modelRequest(sid, { input_tokens: 1, output_tokens: 1 })],
      user,
      fetchImpl,
    );

    expect(posts).toHaveLength(1);
    expect((posts[0]!.body as { text: string }).text).toContain(
      "2026-09-11T17",
    );
    expect(
      await store!.hasAudit("alert.hourly_spike", `${user}/2026-09-11T17`),
    ).toBe(true);

    // The audit fact dedups the same hour; a fresh hour alarms again.
    await runAlertChecks(
      store!,
      [modelRequest(sid, { input_tokens: 1, output_tokens: 1 })],
      user,
      fetchImpl,
    );
    expect(posts).toHaveLength(1);
    const later = `sess_alert-${crypto.randomUUID().slice(0, 8)}`;
    const at19z = {
      ...modelRequest(later, { input_tokens: 200, output_tokens: 50 }),
      occurred_at: "2026-09-11T19:10:00Z",
    };
    await store!.appendEvents([at19z], user);
    await runAlertChecks(store!, [at19z], user, fetchImpl);
    expect(posts).toHaveLength(2);
    expect((posts[1]!.body as { text: string }).text).toContain(
      "2026-09-11T19",
    );
  });

  test("no webhook URL configured → checks stay silent", async () => {
    await ensure();
    const user = `alert-${crypto.randomUUID().slice(0, 8)}`;
    const sid = `sess_alert-${crypto.randomUUID().slice(0, 8)}`;
    await store!.setSetting("webhook_url", "");
    await store!.setSetting("alert_zero_tool_tokens", "10");
    const { posts, fetchImpl } = recorder();
    await store!.appendEvents(
      [
        sessionStart(sid),
        modelRequest(sid, { input_tokens: 100, output_tokens: 0 }),
      ],
      user,
    );
    await runAlertChecks(
      store!,
      [modelRequest(sid, { input_tokens: 1, output_tokens: 0 })],
      user,
      fetchImpl,
    );
    expect(posts).toHaveLength(0);
    expect(await store!.hasAudit("alert.zero_tool_burn", sid)).toBe(false);
  });

  test("cleanup", async () => {
    if (store) await store.close();
  });
});
