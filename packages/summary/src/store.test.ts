import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summaryStore } from "./store";

const tempBase = (): string =>
  join(mkdtempSync(join(tmpdir(), "slopwatch-summary-")), "sess_1");

const cacheOf = (body: string, folded: number) => ({
  body,
  model: "glm-4",
  folded,
  updatedAt: "2026-09-10T12:00:00.000Z",
});

describe("summaryStore cache", () => {
  test("round-trips the cache file", () => {
    const store = summaryStore(tempBase());
    const cache = cacheOf("Did a thing.", 3);
    store.saveCache(cache);
    expect(store.loadCache()).toEqual(cache);
  });

  test("missing cache loads as null", () => {
    expect(summaryStore(tempBase()).loadCache()).toBeNull();
  });

  test("corrupt cache loads as null instead of throwing", () => {
    const base = tempBase();
    const store = summaryStore(base);
    writeFileSync(store.paths.cache, "{not json");
    expect(store.loadCache()).toBeNull();
  });

  test("a cache without the required fields loads as null", () => {
    const base = tempBase();
    const store = summaryStore(base);
    writeFileSync(store.paths.cache, JSON.stringify({ body: "x" }));
    expect(store.loadCache()).toBeNull();
  });
});

describe("summaryStore digests", () => {
  test("appends and lists pending digests in order", () => {
    const store = summaryStore(tempBase());
    store.appendDigest("turn 1: fix the bug");
    store.appendDigest("turn 2: fix the tests");
    expect(store.pendingDigests()).toEqual([
      "turn 1: fix the bug",
      "turn 2: fix the tests",
    ]);
  });

  test("no digests yet means empty pending", () => {
    expect(summaryStore(tempBase()).pendingDigests()).toEqual([]);
  });

  test("clearDigests empties the log without touching the cache", () => {
    const store = summaryStore(tempBase());
    store.appendDigest("a");
    store.saveCache(cacheOf("b", 1));
    store.clearDigests();
    expect(store.pendingDigests()).toEqual([]);
    expect(store.loadCache()?.body).toBe("b");
  });

  test("digest entries are JSON-encoded — embedded newlines stay one entry", () => {
    const store = summaryStore(tempBase());
    store.appendDigest("line1\nline2");
    store.appendDigest("line3");
    expect(store.pendingDigests()).toEqual(["line1\nline2", "line3"]);
  });

  test("paths sit next to the state base with distinct suffixes", () => {
    const store = summaryStore(join("d", "sess"));
    expect(store.paths.cache).toBe(join("d", "sess.summary.json"));
    expect(store.paths.digests).toBe(join("d", "sess.digest.jsonl"));
  });
});
