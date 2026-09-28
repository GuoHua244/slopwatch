import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "@slopwatch/config";
import type { NormalEvent } from "@slopwatch/events";
import { promptRecord } from "./fixtures/transcript-record";

// live.ts with no --server-url/--token argv must pick the credentials up
// from ~/.slopwatch/config.json (relocated here via SLOPWATCH_HOME) — the
// path installed hooks take once slopwatch install stops embedding the
// token in hook command lines.

const received: NormalEvent[][] = [];
const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/healthz") return new Response("ok");
    // the fold gate probes credential status on every end — these fixtures
    // exercise the unconfigured path
    if (path === "/summary/llm") return Response.json({ configured: false });
    const body = (await req.json()) as { events: NormalEvent[] };
    received.push(body.events);
    return Response.json({ accepted: body.events.length });
  },
});

const home = mkdtempSync(join(tmpdir(), "slopwatch-claude-live-config-"));
const transcript = join(home, "transcript.jsonl");
saveConfig(
  { serverUrl: `http://127.0.0.1:${server.port}`, token: "config-token" },
  home,
);

const spawnLive = async (): Promise<void> => {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "live.ts"),
      "--file",
      transcript,
      "--session-id",
      "sess_live-config-test",
      "--cwd",
      home,
      "--idle-ms",
      "300",
      "--max-lifetime-ms",
      "4000",
    ],
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SLOPWATCH_HOME: home,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`live.ts exited ${code}: ${stderr}`);
};

describe("claude-code live.ts ships via the central config", () => {
  test("no argv credentials — the config file supplies them", async () => {
    writeFileSync(transcript, `${JSON.stringify(promptRecord)}\n`);
    await spawnLive();
    expect(received.length).toBeGreaterThan(0);
    expect(
      received.flat().filter((e) => e.kind === "session" && e.event === "start")
        .length,
    ).toBe(1);
  }, 30000);

  test("cleanup", () => {
    server.stop(true);
  });
});
