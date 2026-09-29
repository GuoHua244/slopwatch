import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEndEvent } from "@slopwatch/events";
import { SendError } from "@slopwatch/events";
import { createDiskQueue } from "./disk-queue";

const tmpFile = (): string =>
  join(mkdtempSync(join(tmpdir(), "slopwatch-queue-")), "test.queue.jsonl");

let seq = 0;
const event = (tag?: string): SessionEndEvent => {
  seq += 1;
  return {
    schema_version: 1,
    agent: "zcode",
    session_id: "sess_queue-test",
    occurred_at: "2026-09-13T00:00:00.000Z",
    kind: "session",
    event: "end",
    reason: tag ?? `batch-${seq}`,
  };
};
const reasonOf = (e: SessionEndEvent): string => e.reason ?? "";

describe("disk queue", () => {
  test("enqueue → stats → replay in order", async () => {
    const queue = createDiskQueue({ file: tmpFile() });
    expect(queue.enqueue([event()])).toEqual({
      droppedEvents: 0,
      droppedReasons: {},
    });
    expect(queue.enqueue([event(), event()])).toEqual({
      droppedEvents: 0,
      droppedReasons: {},
    });
    expect(queue.stats().entries).toBe(2);
    expect(queue.stats().events).toBe(3);

    const batches: string[][] = [];
    const result = await queue.replay(async (events) => {
      batches.push(events.map((e) => reasonOf(e as SessionEndEvent)));
    });
    expect(result).toEqual({
      sentEvents: 3,
      droppedEvents: 0,
      droppedReasons: {},
    });
    expect(batches.length).toBe(2);
    expect(batches[0]!.length).toBe(1);
    expect(batches[1]!.length).toBe(2);
    expect(queue.stats().entries).toBe(0);
  });

  test("replay stops at first failure and keeps the rest", async () => {
    const queue = createDiskQueue({ file: tmpFile() });
    queue.enqueue([event("b1")]);
    queue.enqueue([event("b2")]);
    queue.enqueue([event("b3")]);

    let failures = 1;
    const result = await queue.replay(async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("server down");
      }
    });
    expect(result.sentEvents).toBe(0); // first send failed → nothing consumed
    expect(queue.stats().entries).toBe(3);

    const second = await queue.replay(async () => {});
    expect(second.sentEvents).toBe(3);
    expect(queue.stats().entries).toBe(0);
  });

  test("a rewrite does not consume a concurrent writer's in-flight temp file", () => {
    const file = tmpFile();
    const queue = createDiskQueue({ file });
    queue.enqueue([event("first")]);
    // the old shared temp name, caught mid-write by another process
    const foreign = `${file}.tmp`;
    writeFileSync(foreign, "torn");
    queue.enqueue([event("second")]);
    expect(queue.stats().entries).toBe(2);
    expect(readFileSync(foreign, "utf8")).toBe("torn"); // untouched
  });

  test("corrupt lines are removed and counted as dropped", () => {
    const file = tmpFile();
    const queue = createDiskQueue({ file });
    queue.enqueue([event()]);
    // simulate a torn write: truncate the JSON mid-line
    const firstLine = readFileSync(file, "utf8").split("\n")[0]!;
    writeFileSync(file, `${firstLine.slice(0, -8)}\n`);

    const after = createDiskQueue({ file });
    expect(after.stats().entries).toBe(0); // torn line is not an entry
    const { droppedEvents, droppedReasons } = after.enqueue([event()]);
    expect(droppedEvents).toBe(1); // the corrupt line counted as dropped
    expect(droppedReasons).toEqual({ "corrupt-line": 1 });
    expect(after.stats().entries).toBe(1); // the new batch survived
  });

  test("entries older than maxAgeMs are dropped on enqueue", () => {
    let now = Date.parse("2026-09-13T00:00:00.000Z");
    const queue = createDiskQueue({
      file: tmpFile(),
      maxAgeMs: 1000,
      now: () => now,
    });
    queue.enqueue([event(), event()]);
    now += 2000; // the first batch ages out
    const { droppedEvents, droppedReasons } = queue.enqueue([event()]);
    expect(droppedEvents).toBe(2);
    expect(droppedReasons).toEqual({ "age-expired": 2 });
    expect(queue.stats().entries).toBe(1);
    expect(queue.stats().events).toBe(1);
  });

  test("byte cap drops oldest batches first", async () => {
    const file = tmpFile();
    const singleLine = JSON.stringify({
      enqueued_at: "2026-09-13T00:00:00.000Z",
      events: [event("sized")],
    });
    const lineSize = Buffer.byteLength(`${singleLine}\n`, "utf8");
    const queue = createDiskQueue({ file, maxBytes: lineSize * 2 + 10 });
    expect(queue.enqueue([event("b1")]).droppedEvents).toBe(0);
    queue.enqueue([event("b2")]);
    const third = queue.enqueue([event("b3")]); // over cap → b1 dropped
    expect(third.droppedEvents).toBe(1);
    expect(third.droppedReasons).toEqual({ "byte-cap": 1 });

    const reasons: string[] = [];
    await queue.replay(async (events) => {
      for (const e of events) reasons.push(reasonOf(e as SessionEndEvent));
    });
    expect(reasons).toEqual(["b2", "b3"]);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("");
  });

  test("emptying the queue leaves an empty file, not a missing one", async () => {
    const file = tmpFile();
    const queue = createDiskQueue({ file });
    queue.enqueue([event()]);
    await queue.replay(async () => {});
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("");
  });

  test("a permanently rejected batch is dropped and later batches still flow", async () => {
    const queue = createDiskQueue({ file: tmpFile() });
    queue.enqueue([event("poison")]);
    queue.enqueue([event("good")]);

    const reasons: string[] = [];
    const result = await queue.replay(async (events) => {
      for (const e of events) {
        if (reasonOf(e as SessionEndEvent) === "poison")
          throw new SendError(400);
        reasons.push(reasonOf(e as SessionEndEvent));
      }
    });
    expect(result).toEqual({
      sentEvents: 1,
      droppedEvents: 1,
      droppedReasons: { "poison-batch": 1 },
    });
    expect(reasons).toEqual(["good"]);
    expect(queue.stats().entries).toBe(0);
  });

  test("429 and 5xx stay transient — the head is kept for replay", async () => {
    for (const status of [429, 500]) {
      const queue = createDiskQueue({ file: tmpFile() });
      queue.enqueue([event("held")]);
      const result = await queue.replay(async () => {
        throw new SendError(status);
      });
      expect(result).toEqual({
        sentEvents: 0,
        droppedEvents: 0,
        droppedReasons: {},
      });
      expect(queue.stats().entries).toBe(1);
    }
  });

  test("a single batch larger than the cap is dropped, not admitted", () => {
    const file = tmpFile();
    const filler = JSON.stringify({
      enqueued_at: "2026-09-13T00:00:00.000Z",
      events: [event("sized")],
    });
    const lineSize = Buffer.byteLength(`${filler}\n`, "utf8");
    const queue = createDiskQueue({ file, maxBytes: lineSize });
    queue.enqueue([event("keep")]);
    const big = event();
    (big as SessionEndEvent).reason = "x".repeat(lineSize);
    const result = queue.enqueue([big]);
    expect(result.droppedEvents).toBe(1);
    expect(result.droppedReasons).toEqual({ "oversized-batch": 1 });
    expect(queue.stats().entries).toBe(1); // the oversized batch never landed
    expect(readFileSync(file, "utf8")).toContain("keep");
  });
});
