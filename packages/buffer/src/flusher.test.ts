import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNormalEvent, type NormalEvent } from "@slopwatch/events";
import { createDiskQueue } from "./disk-queue";
import { createFlusher } from "./flusher";

const dir = mkdtempSync(join(tmpdir(), "slopwatch-flusher-"));
const queueFile = join(dir, "test.queue.jsonl");

let seq = 0;
const event = (tag: string): NormalEvent => {
  seq += 1;
  return {
    schema_version: 1,
    agent: "zcode",
    session_id: "sess_flush-test",
    occurred_at: "2026-09-13T00:00:00.000Z",
    kind: "session",
    event: "end",
    reason: tag,
  };
};

const newFlusher = (overrides?: {
  send?: (events: NormalEvent[]) => Promise<void>;
  maxBytes?: number;
}) => {
  const sent: NormalEvent[][] = [];
  const send = overrides?.send ?? (async (events) => void sent.push(events));
  const flusher = createFlusher({
    agent: "zcode",
    sessionId: "sess_flush-test",
    send,
    queue: createDiskQueue({
      file: queueFile,
      ...(overrides?.maxBytes ? { maxBytes: overrides.maxBytes } : {}),
    }),
    onInvalid: () => {},
  });
  return { flusher, sent };
};

describe("flusher", () => {
  test("healthy server: batches pass straight through", async () => {
    const { flusher, sent } = newFlusher();
    const result = await flusher.flush([event("a")]);
    expect(result).toBe("sent");
    expect(sent.length).toBe(1);
    expect(sent[0]![0]!.kind).toBe("session");
  });

  test("server down: batch queued; recovery replays backlog before new events", async () => {
    let down = true;
    const seen: string[] = [];
    const { flusher } = newFlusher({
      send: async (events) => {
        if (down) throw new Error("ECONNREFUSED");
        for (const e of events) {
          if (e.kind === "quarantine") continue;
          seen.push((e as { reason?: string }).reason ?? e.kind);
        }
      },
    });

    expect(await flusher.flush([event("offline-1")])).toBe("queued");
    expect(await flusher.flush([event("offline-2")])).toBe("queued");

    down = false; // server returns
    expect(await flusher.flush([event("online")])).toBe("sent");
    // backlog oldest-first, then the live batch
    expect(seen).toEqual(["offline-1", "offline-2", "online"]);
  });

  test("queue overflow drops are reported as a quarantine event on recovery", async () => {
    const lineSize = Buffer.byteLength(
      `${JSON.stringify({
        enqueued_at: new Date().toISOString(),
        events: [event("x")],
      })}\n`,
      "utf8",
    );
    let down = true;
    const quarantines: NormalEvent[] = [];
    const { flusher } = newFlusher({
      maxBytes: lineSize * 2,
      send: async (events) => {
        if (down) throw new Error("ECONNREFUSED");
        for (const e of events)
          if (e.kind === "quarantine") quarantines.push(e);
      },
    });

    await flusher.flush([event("q1")]);
    await flusher.flush([event("q2")]);
    await flusher.flush([event("q3")]); // over cap → oldest dropped
    expect(flusher.pendingDrops()).toBeGreaterThan(0);

    down = false;
    await flusher.flush([event("after")]);
    const overflow = quarantines.find(
      (e) => e.kind === "quarantine" && e.reason === "buffer-overflow",
    );
    expect(overflow).toBeDefined();
    expect(isNormalEvent(overflow!)).toBe(true);
    expect(flusher.pendingDrops()).toBe(0);
  });

  test("invalid events are filtered and reported, never sent", async () => {
    const invalid = { kind: "bogus" } as unknown as NormalEvent;
    const invalids: NormalEvent[] = [];
    const { flusher, sent } = newFlusher();
    // rebuild with a spy for invalids
    const spy = createFlusher({
      agent: "zcode",
      sessionId: "sess_flush-test",
      send: async (events) => void sent.push(events),
      queue: createDiskQueue({ file: queueFile }),
      onInvalid: (e) => invalids.push(e),
    });
    await spy.flush([event("valid"), invalid]);
    expect(invalids).toEqual([invalid]);
    const flat = sent.flat();
    expect(flat.some((e) => !isNormalEvent(e))).toBe(false);
    expect(flat.filter((e) => e.kind === "session").length).toBe(1);
  });

  test("empty batch with nothing pending is a no-op send", async () => {
    const { flusher, sent } = newFlusher();
    expect(await flusher.flush([])).toBe("sent");
    expect(sent.length).toBe(0);
  });
});
