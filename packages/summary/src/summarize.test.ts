import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUserPrompt, foldSummary, SYSTEM_PROMPT } from "./summarize";
import { summaryStore } from "./store";

const tempBase = (): string =>
  join(mkdtempSync(join(tmpdir(), "slopwatch-fold-")), "sess_1");

const llm = { endpoint: "http://llm.test/v1", model: "glm-4", apiKey: "k" };

type FetchLike = (url?: unknown, init?: unknown) => Promise<Response>;
const asFetch = (fn: FetchLike): typeof fetch => fn as unknown as typeof fetch;
const okFetch =
  (text: string): FetchLike =>
  async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));

const captureUser = (seen: { user?: string }) =>
  asFetch(async (_url, init) => {
    const body = JSON.parse(String((init as { body?: unknown })?.body)) as {
      messages: { role: string; content: string }[];
    };
    seen.user = body.messages.find((m) => m.role === "user")?.content;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
    );
  });

describe("buildUserPrompt", () => {
  test("first fold says so; later folds embed the prior summary", () => {
    expect(buildUserPrompt(null, ["a"])).toContain("(none");
    const prompt = buildUserPrompt("Prior work.", ["a", "b"]);
    expect(prompt).toContain("PRIOR SUMMARY:\nPrior work.");
    expect(prompt).toContain("- a\n- b");
  });
});

describe("foldSummary", () => {
  test("with no pending digests it skips the LLM entirely", async () => {
    let called = 0;
    const event = await foldSummary({
      stateBase: tempBase(),
      agent: "zcode",
      sessionId: "s1",
      llm,
      fetchImpl: asFetch(async () => {
        called += 1;
        return okFetch("x")();
      }),
    });
    expect(event).toBeNull();
    expect(called).toBe(0);
  });

  test("folds pending digests and emits a valid summary event", async () => {
    const base = tempBase();
    const store = summaryStore(base);
    store.appendDigest("turn 1: fix the bug (2 requests, 12k in)");
    const event = await foldSummary({
      stateBase: base,
      agent: "zcode",
      sessionId: "s1",
      llm,
      fetchImpl: asFetch(async (_url, init) => {
        const body = JSON.parse(String((init as { body?: unknown })?.body)) as {
          messages: { role: string; content: string }[];
        };
        const user = body.messages.find((m) => m.role === "user")?.content;
        const system = body.messages.find((m) => m.role === "system")?.content;
        expect(system).toBe(SYSTEM_PROMPT);
        expect(user).toContain("turn 1: fix the bug");
        expect(user).toContain("(none");
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "Fixed the bug; tests green." } }],
          }),
        );
      }),
    });
    expect(event).toMatchObject({
      schema_version: 1,
      agent: "zcode",
      session_id: "s1",
      kind: "session",
      event: "summary",
      body: "Fixed the bug; tests green.",
      model: "glm-4",
    });

    // the fold point advanced and the log emptied
    expect(store.loadCache()).toMatchObject({
      body: "Fixed the bug; tests green.",
      folded: 1,
    });
    expect(store.pendingDigests()).toEqual([]);
  });

  test("the next fold rolls on top of the previous summary", async () => {
    const base = tempBase();
    const store = summaryStore(base);
    store.appendDigest("turn 1");
    await foldSummary({
      stateBase: base,
      agent: "zcode",
      sessionId: "s1",
      llm,
      fetchImpl: asFetch(okFetch("Summary v1.")),
    });
    store.appendDigest("turn 2");
    store.appendDigest("turn 3");
    const seen: { user?: string } = {};
    const event = await foldSummary({
      stateBase: base,
      agent: "zcode",
      sessionId: "s1",
      llm,
      fetchImpl: captureUser(seen),
    });
    void event;
    expect(seen.user).toContain("PRIOR SUMMARY:\nSummary v1.");
    expect(seen.user).toContain("- turn 2\n- turn 3");
    expect(store.loadCache()?.folded).toBe(3);
  });

  test("an LLM failure keeps the digests pending and the cache untouched", async () => {
    const base = tempBase();
    const store = summaryStore(base);
    store.appendDigest("turn 1");
    store.saveCache({
      body: "prior",
      model: "glm-4",
      folded: 5,
      updatedAt: "2026-09-10T12:00:00.000Z",
    });
    const event = await foldSummary({
      stateBase: base,
      agent: "zcode",
      sessionId: "s1",
      llm,
      fetchImpl: asFetch(async () => new Response("nope", { status: 500 })),
    });
    expect(event).toBeNull();
    expect(store.pendingDigests()).toEqual(["turn 1"]);
    expect(store.loadCache()?.folded).toBe(5);
  });
});
