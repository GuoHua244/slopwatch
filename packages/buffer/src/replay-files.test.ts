import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalEvent, SessionEndEvent } from "@slopwatch/events";
import { createDiskQueue } from "./disk-queue";
import { replayQueueFiles } from "./replay-files";

const dir = mkdtempSync(join(tmpdir(), "slopwatch-replayfiles-"));

const event = (sessionId: string): NormalEvent => ({
  schema_version: 1,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: "2026-09-13T00:00:00.000Z",
  kind: "session",
  event: "end",
  reason: "idle-timeout",
});

describe("replayQueueFiles", () => {
  test("drains every matching queue file, leaves empty ones alone", async () => {
    const kept = createDiskQueue({
      file: join(dir, "zcode-sess_a.queue.jsonl"),
    });
    kept.enqueue([event("sess_a")]);
    const other = createDiskQueue({
      file: join(dir, "claude-code-sess_b.queue.jsonl"),
    });
    other.enqueue([event("sess_b")]);
    // a matching but already-empty file must not count as work
    createDiskQueue({ file: join(dir, "zcode-sess_c.queue.jsonl") });

    const seen: string[] = [];
    const result = await replayQueueFiles({
      dir,
      pattern: /^zcode-.*\.queue\.jsonl$/,
      send: async (events) => {
        for (const e of events) seen.push((e as SessionEndEvent).session_id);
      },
    });
    expect(result.files).toBe(1);
    expect(result.sentEvents).toBe(1);
    expect(seen).toEqual(["sess_a"]);
    expect(kept.stats().entries).toBe(0);
    expect(other.stats().entries).toBe(1); // other pattern untouched
  });

  test("missing directory is a clean no-op", async () => {
    const result = await replayQueueFiles({
      dir: join(dir, "does-not-exist"),
      pattern: /.*/,
      send: async () => {},
    });
    expect(result).toEqual({ files: 0, sentEvents: 0 });
  });
});
