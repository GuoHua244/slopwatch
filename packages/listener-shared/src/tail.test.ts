import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalEvent } from "@slopwatch/events";
import { createTailLoop, type RecordAdapter } from "./tail";

// The delivery acks: adapters that gate emissions on delivery (the
// session-title gate) commit their gate only on the ack, so the loop must
// ack exactly the batches that actually shipped — success after the cursor
// commit, failure for any batch whose drain aborted partway.

const event = (): NormalEvent => ({
  schema_version: 1,
  agent: "claude-code",
  session_id: "sess_test",
  occurred_at: new Date().toISOString(),
  kind: "session",
  event: "end",
});

const makeLoop = (opts?: {
  flushError?: Error;
  normalizeError?: boolean;
}): {
  file: string;
  cursorFile: string;
  acks: { flushed: NormalEvent[][]; failed: NormalEvent[][] };
  drain: () => Promise<void>;
} => {
  const dir = mkdtempSync(join(tmpdir(), "slopwatch-tail-"));
  const file = join(dir, "capture.jsonl");
  const lines = opts?.normalizeError
    ? ['{"type":"user"}\n', '{"type":"user","boom":true}\n']
    : ['{"type":"user"}\n'];
  writeFileSync(file, lines.join(""));
  const cursorFile = join(dir, "capture.cursor");
  const acks = {
    flushed: [] as NormalEvent[][],
    failed: [] as NormalEvent[][],
  };
  const adapter: RecordAdapter = {
    driftFromRecord: () => null,
    eventsFromRecord: (record) => {
      if ((record as { boom?: boolean }).boom) throw new Error("boom");
      return [event()];
    },
    onFlushed: (batch) => acks.flushed.push(batch),
    onFlushFailed: (batch) => acks.failed.push(batch),
  };
  const { drain } = createTailLoop({
    file,
    cursorFile,
    agent: "claude-code",
    sessionId: "sess_test",
    adapter,
    digest: { close: () => {}, observe: () => {} } as never,
    flush: async () => {
      if (opts?.flushError) throw opts.flushError;
    },
    resetIdle: () => {},
  });
  return { file, cursorFile, acks, drain };
};

describe("createTailLoop delivery acks", () => {
  test("a shipped batch is acked once, a quiet drain is not", async () => {
    const { cursorFile, acks, drain } = makeLoop();
    await drain();
    expect(acks.flushed).toHaveLength(1);
    expect(acks.flushed[0]).toHaveLength(1);
    expect(acks.failed).toHaveLength(0);
    // the cursor committed before the ack — the success pair travels together
    expect(Number(readFileSync(cursorFile, "utf8"))).toBeGreaterThan(0);
    await drain(); // nothing new
    expect(acks.flushed).toHaveLength(1);
  });

  test("a rejected flush acks failure and never commits the cursor", async () => {
    const { cursorFile, acks, drain } = makeLoop({
      flushError: new Error("post failed"),
    });
    await drain();
    expect(acks.failed).toHaveLength(1);
    expect(acks.failed[0]).toHaveLength(1);
    expect(acks.flushed).toHaveLength(0);
    expect(existsSync(cursorFile)).toBe(false);
  });

  test("a normalization throw acks failure for the events already built", async () => {
    const { acks, drain } = makeLoop({ normalizeError: true });
    await drain();
    expect(acks.failed).toHaveLength(1);
    // the first record's event made it into the aborted batch
    expect(acks.failed[0]).toHaveLength(1);
    expect(acks.flushed).toHaveLength(0);
  });
});
