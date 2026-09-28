import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_FOLD_DIGEST_BYTES,
  buildUserPrompt,
  FOLD_MAX_TOKENS,
  foldSummary,
  SYSTEM_PROMPT,
  type FoldLlm,
} from "./summarize";
import { summaryStore } from "./store";

const tempBase = (): string =>
  join(mkdtempSync(join(tmpdir(), "slopwatch-fold-")), "sess_1");

const okLlm =
  (
    text: string,
    seen?: { system?: string; user?: string; maxTokens?: number },
  ): FoldLlm =>
  async (req) => {
    if (seen) {
      seen.system = req.system;
      seen.user = req.user;
      seen.maxTokens = req.maxTokens;
    }
    return { text, model: "glm-4" };
  };

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
      llm: async () => {
        called += 1;
        return { text: "x", model: "glm-4" };
      },
    });
    expect(event).toBeNull();
    expect(called).toBe(0);
  });

  test("folds pending digests and emits a valid summary event", async () => {
    const base = tempBase();
    const store = summaryStore(base);
    store.appendDigest("turn 1: fix the bug (2 requests, 12k in)");
    const seen: { system?: string; user?: string; maxTokens?: number } = {};
    const event = await foldSummary({
      stateBase: base,
      agent: "zcode",
      sessionId: "s1",
      llm: okLlm("Fixed the bug; tests green.", seen),
    });
    expect(seen.system).toBe(SYSTEM_PROMPT);
    expect(seen.user).toContain("turn 1: fix the bug");
    expect(seen.user).toContain("(none");
    expect(seen.maxTokens).toBe(FOLD_MAX_TOKENS);
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

  test("the emitted event carries the fold's token usage", async () => {
    const base = tempBase();
    const store = summaryStore(base);
    store.appendDigest("turn 1");
    const event = await foldSummary({
      stateBase: base,
      agent: "zcode",
      sessionId: "s1",
      llm: async () => ({
        text: "Folded.",
        model: "glm-4",
        usage: {
          input_tokens: 500,
          output_tokens: 120,
          cache_read_tokens: 300,
          reasoning_tokens: 90,
        },
      }),
    });
    expect(event?.usage).toEqual({
      input_tokens: 500,
      output_tokens: 120,
      cache_read_tokens: 300,
      reasoning_tokens: 90,
    });
  });

  test("the next fold rolls on top of the previous summary", async () => {
    const base = tempBase();
    const store = summaryStore(base);
    store.appendDigest("turn 1");
    await foldSummary({
      stateBase: base,
      agent: "zcode",
      sessionId: "s1",
      llm: okLlm("Summary v1."),
    });
    store.appendDigest("turn 2");
    store.appendDigest("turn 3");
    const seen: { user?: string } = {};
    const event = await foldSummary({
      stateBase: base,
      agent: "zcode",
      sessionId: "s1",
      llm: okLlm("Summary v2.", seen),
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
      llm: async () => ({ text: null, model: "" }),
    });
    expect(event).toBeNull();
    expect(store.pendingDigests()).toEqual(["turn 1"]);
    expect(store.loadCache()?.folded).toBe(5);
  });

  test("a digest appended mid-fold survives: the fold consumes only its snapshot", async () => {
    const base = tempBase();
    const store = summaryStore(base);
    store.appendDigest("turn 1: snapshot digest");

    let resolveLlm!: (result: { text: string; model: string }) => void;
    const gated = new Promise<{ text: string; model: string }>((resolve) => {
      resolveLlm = resolve;
    });
    const seen: { user?: string } = {};
    // the completion blocks on a deferred promise; the prompt capture
    // happens synchronously when foldSummary initiates the call
    const inFlight = foldSummary({
      stateBase: base,
      agent: "zcode",
      sessionId: "s1",
      llm: async (req) => {
        seen.user = req.user;
        return gated;
      },
    });

    // the fold has its snapshot now (the LLM was entered above) — a new
    // digest lands while the call is still in flight
    store.appendDigest("turn 2: appended mid-fold");
    resolveLlm({ text: "Folded.", model: "glm-4" });
    const event = await inFlight;

    expect(event?.body).toBe("Folded.");
    expect(seen.user).toContain("turn 1: snapshot digest");
    expect(seen.user).not.toContain("turn 2");
    expect(store.loadCache()?.folded).toBe(1);
    // the mid-fold digest was NOT deleted unfolded — it folds next time
    expect(store.pendingDigests()).toEqual(["turn 2: appended mid-fold"]);
  });

  test("a backlog bigger than the byte cap folds only the oldest digests", async () => {
    const base = tempBase();
    const store = summaryStore(base);
    const big = "x".repeat(2000);
    const total = 30; // ~60KB of digests — well past the 32KB prompt budget
    for (let i = 0; i < total; i += 1) store.appendDigest(`${i}: ${big}`);

    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    const seen: { user?: string } = {};
    let event: Awaited<ReturnType<typeof foldSummary>>;
    try {
      event = await foldSummary({
        stateBase: base,
        agent: "zcode",
        sessionId: "s1",
        llm: okLlm("Folded.", seen),
      });
    } finally {
      console.error = originalError;
    }

    expect(event).not.toBeNull();
    // the prompt holds a chronological prefix within the budget — the oldest
    // digests, never the newest ones
    expect(seen.user).toContain("0: ");
    expect(seen.user).not.toContain(`${total - 1}: `);
    // overflow is logged, not silent
    expect(
      errors.some((args) =>
        String(args.join(" ")).includes("fold prompt capped"),
      ),
    ).toBe(true);
    // what did not fit stays pending for the next fold
    const remaining = store.pendingDigests();
    expect(remaining.length).toBeGreaterThan(0);
    expect(store.loadCache()?.folded).toBe(total - remaining.length);
    expect(remaining.at(-1)).toBe(`${total - 1}: ${big}`);
    expect(MAX_FOLD_DIGEST_BYTES).toBe(32_000);
  });
});
