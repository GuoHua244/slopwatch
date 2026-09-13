import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "@slopwatch/config";
import type { NormalEvent } from "@slopwatch/events";
import { assistantRecord, promptRecord } from "./fixtures/transcript-record";

// The rolling-summary end path (open question 15): each listener generation
// folds the turns added since the last end into the previous summary with
// one LLM call, ships session/summary before session:end, and skips the
// LLM entirely on ends with no new turns.

const received: NormalEvent[][] = [];
const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
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

const home = mkdtempSync(join(tmpdir(), "slopwatch-claude-live-sum-"));
const transcript = join(home, "transcript.jsonl");
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

const prompt = (uuid: string, text: string): string =>
  JSON.stringify({
    ...promptRecord,
    uuid,
    timestamp: `2026-09-10T09:0${uuid.length % 10}:00.000Z`,
    message: { role: "user", content: text },
  });

const assistant = (messageId: string, parent: string): string =>
  JSON.stringify({
    ...assistantRecord,
    uuid: `a-${messageId}`,
    parentUuid: parent,
    message: { ...assistantRecord.message, id: messageId },
  });

const spawnLive = async (): Promise<void> => {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "live.ts"),
      "--file",
      transcript,
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

describe("claude-code live.ts rolling summaries", () => {
  test("generation 1 folds its turn and ships summary before end", async () => {
    writeFileSync(
      transcript,
      [
        prompt("u-001", "帮我看看这个仓库的结构"),
        assistant("msg_01A", "u-001"),
      ].join("\n") + "\n",
    );
    await spawnLive();
    expect(summaries()).toEqual([{ body: "summary #1", model: "test-model" }]);
    expect(llmCalls[0]).toContain('turn 1: "帮我看看这个仓库的结构"');
    const lastBatch = received[received.length - 1];
    expect((lastBatch[0] as { event: string }).event).toBe("summary");
    expect((lastBatch[1] as { event: string }).event).toBe("end");
  }, 30000);

  test("generation 2 rolls on top of the prior summary", async () => {
    appendFileSync(
      transcript,
      [
        prompt("u-002", "修掉刚才发现的 bug"),
        assistant("msg_01B", "u-002"),
      ].join("\n") + "\n",
    );
    await spawnLive();
    const s = summaries();
    expect(s).toHaveLength(2);
    expect(s[1].body).toBe("summary #2");
    expect(llmCalls[1]).toContain("PRIOR SUMMARY:\nsummary #1");
    expect(llmCalls[1]).toContain('turn 2: "修掉刚才发现的 bug"');
    expect(llmCalls[1]).not.toContain("turn 1:");
  }, 30000);

  test("an end with no new turns skips the LLM entirely", async () => {
    const callsBefore = llmCalls.length;
    await spawnLive(); // no appends — cursor already at EOF
    expect(summaries()).toHaveLength(2);
    expect(llmCalls.length).toBe(callsBefore);
  }, 30000);

  test("cleanup", () => {
    server.stop(true);
    llm.stop(true);
  });
});
