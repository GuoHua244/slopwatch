/**
 * The shared flush path for both listeners (v2 decision 21).
 * Replaces the old "POST fails → exit(1), cursor stays" contract: a failed
 * send now queues the batch on disk, so the caller can advance its cursor
 * (the data lives in the queue, not in the rollout file ZCode may delete).
 * Ordering is preserved: the queue replays oldest-first before any new batch
 * — on every flush, including empty ones, so idle polls keep draining a
 * stuck backlog instead of starving it until the next real event.
 * Queue drops (cap overflows) are reported as a quarantine event on the next
 * successful send, so data loss is always visible on the Server's health
 * page; the event's reason stays "buffer-overflow" while the line JSON
 * carries the per-cause breakdown.
 */
import {
  quarantineLine,
  isNormalEvent,
  type NormalEvent,
} from "@slopwatch/events";
import { isPermanentRejection } from "./disk-queue";
import type { DiskQueue, DropCounts } from "./disk-queue";

export type FlushResult = "sent" | "queued";

export type Flusher = {
  flush: (batch: NormalEvent[]) => Promise<FlushResult>;
  /** Events dropped by queue caps since the last successful send. */
  pendingDrops: () => number;
  /** The same drops broken down by reason (empty when pendingDrops() is 0). */
  pendingDropReasons: () => DropCounts;
};

export const createFlusher = (opts: {
  agent: string;
  sessionId: string;
  send: (events: NormalEvent[]) => Promise<void>;
  queue: DiskQueue;
  onInvalid?: (event: NormalEvent) => void;
}): Flusher => {
  let unreportedDrops = 0;
  let unreportedReasons: DropCounts = {};

  const addDrops = (drops: {
    droppedEvents: number;
    droppedReasons?: DropCounts;
  }): void => {
    unreportedDrops += drops.droppedEvents;
    for (const [reason, count] of Object.entries(drops.droppedReasons ?? {})) {
      const key = reason as keyof DropCounts;
      unreportedReasons[key] = (unreportedReasons[key] ?? 0) + (count ?? 0);
    }
  };

  const overflowEvent = (count: number, reasons: DropCounts): NormalEvent =>
    quarantineLine({
      agent: opts.agent,
      session_id: opts.sessionId,
      // "buffer-overflow" is kept for compatibility; the breakdown lives in
      // the line JSON
      reason: "buffer-overflow",
      line: JSON.stringify({ dropped_events: count, reasons }),
    });

  return {
    pendingDrops: () => unreportedDrops,

    pendingDropReasons: () => ({ ...unreportedReasons }),

    async flush(batch) {
      const valid = batch.filter(isNormalEvent);
      for (const event of batch) {
        if (!isNormalEvent(event)) opts.onInvalid?.(event);
      }

      // Drain the backlog BEFORE the new batch (order guarantee) — always,
      // even when the new batch is empty: the tail loop flushes empty batches
      // on every no-op poll, and skipping the replay there would starve a
      // stuck queue until the next real event arrives.
      const replayed = await opts.queue.replay(opts.send);
      addDrops(replayed);

      const outbound: NormalEvent[] = [];
      if (unreportedDrops > 0) {
        outbound.push(overflowEvent(unreportedDrops, unreportedReasons));
        unreportedDrops = 0;
        unreportedReasons = {};
      }
      outbound.push(...valid);

      if (outbound.length === 0) {
        // Nothing to send this flush. "sent" means nothing was left hanging:
        // the replay drained the queue, or there was nothing queued to begin
        // with. A backlog the server still refuses stays "queued" — the data
        // remains parked on disk.
        return opts.queue.stats().entries === 0 || replayed.sentEvents > 0
          ? "sent"
          : "queued";
      }

      try {
        await opts.send(outbound);
        return "sent";
      } catch (e) {
        if (isPermanentRejection(e)) {
          // The server will never take this batch — counting it as dropped
          // beats queueing a poison head that blocks every later batch.
          addDrops({
            droppedEvents: outbound.length,
            droppedReasons: { "poison-batch": outbound.length },
          });
          return "queued";
        }
        addDrops(opts.queue.enqueue(outbound));
        return "queued";
      }
    },
  };
};
