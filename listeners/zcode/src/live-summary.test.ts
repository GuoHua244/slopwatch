import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "@slopwatch/config";
import type { NormalEvent } from "@slopwatch/events";
import { mainTurnRecord } from "./fixtures/rollout-record";

// The rolling-summary end path (open question 15): each sidecar generation
// folds the turns added since the last end into the previous summary with
// one LLM call, ships session/summary before session:end, and skips the
// LLM entirely on ends with no new turns.

const received: NormalEvent[][] = [];
const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    if (new URL(req.url).pathname === "/healthz") {
      return new Response("ok");
    }
    const body = (await req.json()) as { events: NormalEvent[] };
    received.push(body.events);
    return Response.json({ accepted: body.events.length });
  },
});

// a fake OpenAI-compatible provider: remembers the prompts it was given
const llmCalls: string[] = [];
const llm = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const body = (await req.json()) as {
      messages: { role: string; content: string }[];
    };
    llmCalls.push(body.messages.find((m) => m.role === "user")?.content ?? "");
    return Response.json({
      choices: [{ message: { content: `summary #${llmCalls.length}` } }],
    });
  },
});

const home = mkdtempSync(join(tmpdir(), "slopwatch-zcode-live-sum-"));
const rollout = join(home, "rollout.jsonl");
saveConfig(
  {
    serverUrl: `http://127.0.0.1:${server.port}`,
    token: "config-token",
    summary: {
      endpoint: `http://127.0.0.1:${llm.port}/v1`,
      model: "test-model",
      apiKey: "llm-key",
    },
  },
  home,
);

const turn = (turnId: string, userMessage: string): string => {
  const record = {
    ...mainTurnRecord,
    turnId,
    requestId: `req_${turnId}`,
    request: {
      ...mainTurnRecord.request,
      messages: [
        { role: "user", content: userMessage },
        { role: "assistant", content: "On it." },
      ],
    },
  };
  return JSON.stringify(record);
};

const spawnLive = async (): Promise<void> => {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "live.ts"),
      "--file",
      rollout,
      "--session-id",
      "sess_live-summary-test",
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

const summaries = (): { body: string; model: string }[] =>
  received
    .flat()
    .filter((e) => e.kind === "session" && e.event === "summary")
    .map((e) => ({
      body: (e as { body: string }).body,
      model: (e as { model: string }).model,
    }));

describe("zcode live.ts rolling summaries", () => {
  test("generation 1 folds its turn and ships summary before end", async () => {
    writeFileSync(rollout, `${turn("turn_a", "fix the login bug")}\n`);
    await spawnLive();
    const s = summaries();
    expect(s).toEqual([{ body: "summary #1", model: "test-model" }]);
    expect(llmCalls[0]).toContain('turn 1: "fix the login bug"');
    // summary arrives in the same batch as (before) the end event
    const lastBatch = received[received.length - 1];
    expect(lastBatch[0].kind).toBe("session");
    expect((lastBatch[0] as { event: string }).event).toBe("summary");
    expect((lastBatch[1] as { event: string }).event).toBe("end");
  }, 30000);

  test("generation 2 rolls on top of the prior summary", async () => {
    appendFileSync(rollout, `${turn("turn_b", "add tests for it")}\n`);
    await spawnLive();
    const s = summaries();
    expect(s).toHaveLength(2);
    expect(s[1].body).toBe("summary #2");
    // the second call saw the prior summary and only the new turn
    expect(llmCalls[1]).toContain("PRIOR SUMMARY:\nsummary #1");
    expect(llmCalls[1]).toContain('turn 2: "add tests for it"');
    expect(llmCalls[1]).not.toContain("turn 1:");
  }, 30000);

  test("an end with no new turns skips the LLM entirely", async () => {
    const callsBefore = llmCalls.length;
    await spawnLive(); // no appends — cursor already at EOF
    expect(summaries()).toHaveLength(2);
    expect(llmCalls.length).toBe(callsBefore);
  }, 30000);

  test("an unreachable server skips the fold — no tokens burned for a lost summary", async () => {
    // the server dies the moment its pulse is first checked — /healthz is
    // only ever requested by the fold gate, so the timing is deterministic:
    // startup and backfill POSTs land fine, the idle end faces a dead server
    let down = false;
    const dying = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/healthz") {
          down = true;
          return new Response("down", { status: 503 });
        }
        if (down) return new Response("gone", { status: 503 });
        const body = (await req.json()) as { events: NormalEvent[] };
        received.push(body.events);
        return Response.json({ accepted: body.events.length });
      },
    });
    const downHome = mkdtempSync(join(tmpdir(), "slopwatch-zcode-live-down-"));
    const downRollout = join(downHome, "rollout.jsonl");
    saveConfig(
      {
        serverUrl: `http://127.0.0.1:${dying.port}`,
        token: "config-token",
        summary: {
          endpoint: `http://127.0.0.1:${llm.port}/v1`,
          model: "test-model",
          apiKey: "llm-key",
        },
      },
      downHome,
    );
    writeFileSync(downRollout, `${turn("turn_down", "doomed to drop")}\n`);
    const callsBefore = llmCalls.length;
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        join(import.meta.dir, "live.ts"),
        "--file",
        downRollout,
        "--session-id",
        "sess_live-sum-down",
        "--cwd",
        downHome,
        "--idle-ms",
        "300",
        "--max-lifetime-ms",
        "4000",
      ],
      env: {
        ...process.env,
        HOME: downHome,
        USERPROFILE: downHome,
        SLOPWATCH_HOME: downHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    dying.stop(true);
    expect(code).not.toBe(0); // the end POST fails — that is the point
    expect(stderr).toContain("summary fold skipped");
    expect(llmCalls.length).toBe(callsBefore);
  }, 30000);

  test("cleanup", () => {
    server.stop(true);
    llm.stop(true);
  });
});
