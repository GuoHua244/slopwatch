import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalEvent } from "@slopwatch/events";
import { mainTurnRecord, titleRecord } from "./fixtures/rollout-record";

// ZCode rewrites the (usually unchanged) session_title record on every turn.
// The listener gates titles on the last one DELIVERED, persisted to a sidecar
// so a respawned generation stays gated — and committed only on the flush
// ack, so a batch that never shipped cannot gate its own retry.

const received: NormalEvent[][] = [];
const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/healthz") return new Response("ok");
    if (path === "/summary/llm") return Response.json({ configured: false });
    const body = (await req.json()) as { events: NormalEvent[] };
    received.push(body.events);
    return Response.json({ accepted: body.events.length });
  },
});

const dir = mkdtempSync(join(tmpdir(), "slopwatch-zcode-titles-"));
const home = join(dir, "home");
const mainSessionId = "sess_titles-live-test";
const mainFile = join(dir, `model-io-${mainSessionId}.jsonl`);

const titleLine = (title: string, requestId: string): string =>
  `${JSON.stringify({
    ...titleRecord,
    requestId,
    response: {
      ...(titleRecord.response as Record<string, unknown>),
      text: `{"title":"${title}"}`,
    },
  })}\n`;

const spawnLive = async (): Promise<void> => {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "live.ts"),
      "--file",
      mainFile,
      "--session-id",
      mainSessionId,
      "--cwd",
      dir,
      "--idle-ms",
      "300",
      "--max-lifetime-ms",
      "4000",
      "--server-url",
      `http://127.0.0.1:${server.port}`,
      "--token",
      "test-token",
    ],
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`live.ts exited ${code}: ${stderr}`);
};

const titlesShipped = (): string[] =>
  received
    .flat()
    .filter(
      (e) =>
        e.session_id === mainSessionId &&
        e.kind === "session" &&
        e.event === "meta" &&
        "title" in e,
    )
    .map((e) => (e as { title: string }).title);

describe("zcode live.ts title gate", () => {
  test("identical title rewrites ship once; a retitle ships again", async () => {
    writeFileSync(
      mainFile,
      `${JSON.stringify(mainTurnRecord)}\n` +
        titleLine("first title", "req_t-1") +
        titleLine("first title", "req_t-2") + // the unchanged rewrite
        titleLine("renamed", "req_t-3"),
    );
    await spawnLive();
    expect(titlesShipped()).toEqual(["first title", "renamed"]);
  }, 30000);

  test("a respawned generation stays gated by the persisted sidecar", async () => {
    received.length = 0;
    // the periodic unchanged rewrite, drained by a fresh listener process
    appendFileSync(mainFile, titleLine("renamed", "req_t-4"));
    await spawnLive();
    expect(titlesShipped()).toEqual([]);
  }, 30000);

  test("a version-1 sidecar gates on the event form; a retitle ships again", async () => {
    received.length = 0;
    // a pre-full-title sidecar: the gate holds the event's 200-char form of
    // the long title, where the full string would not compare equal
    const long = "r".repeat(200);
    writeFileSync(
      join(
        home,
        ".slopwatch",
        "listeners",
        `zcode-${mainSessionId}.titles.json`,
      ),
      JSON.stringify({ version: 1, titles: { [mainSessionId]: long } }),
    );
    // the unchanged rewrite of the long title — byte-identical on the wire:
    // suppressed, where the pre-fix behavior re-shipped it once
    appendFileSync(mainFile, titleLine(`${long}tail`, "req_v1-1"));
    await spawnLive();
    expect(titlesShipped()).toEqual([]);
    // a real retitle ships, and the adopted full gate retires the legacy form
    appendFileSync(mainFile, titleLine("after-upgrade", "req_v1-2"));
    await spawnLive();
    expect(titlesShipped()).toEqual(["after-upgrade"]);
  }, 30000);

  test("cleanup", () => {
    server.stop(true);
  });
});
