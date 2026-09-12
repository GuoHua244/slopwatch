/**
 * The shared flush path for both listeners' sidecars (v2 decision 21).
 * Replaces the old "POST fails → exit(1), cursor stays" contract: a failed
 * send now queues the batch on disk, so the caller can advance its cursor
 * (the data lives in the queue, not in the rollout file ZCode may delete).
 * Ordering is preserved: the queue replays oldest-first before any new batch.
 * Queue drops (cap overflows) are reported as a quarantine event on the next
 * successful send, so data loss is always visible on the Server's health page.
 */
import {
  quarantineLine,
  isNormalEvent,
  type NormalEvent,
} from "@slopwatch/events";
import type { DiskQueue } from "./disk-queue";

export type FlushResult = "sent" | "queued";

export type Flusher = {
  flush: (batch: NormalEvent[]) => Promise<FlushResult>;
  /** Events dropped by queue caps since the last successful send. */
  pendingDrops: () => number;
};

export const createFlusher = (opts: {
  agent: string;
  sessionId: string;
  send: (events: NormalEvent[]) => Promise<void>;
  queue: DiskQueue;
  onInvalid?: (event: NormalEvent) => void;
}): Flusher => {
  let unreportedDrops = 0;

  const overflowEvent = (count: number): NormalEvent =>
    quarantineLine({
      agent: opts.agent,
      session_id: opts.sessionId,
      reason: "buffer-overflow",
      line: JSON.stringify({ dropped_events: count }),
    });

  return {
    pendingDrops: () => unreportedDrops,

    async flush(batch) {
      const valid = batch.filter(isNormalEvent);
      for (const event of batch) {
        if (!isNormalEvent(event)) opts.onInvalid?.(event);
      }
      if (valid.length === 0 && unreportedDrops === 0) return "sent";

      const outbound: NormalEvent[] = [];
      if (unreportedDrops > 0) {
        outbound.push(overflowEvent(unreportedDrops));
        unreportedDrops = 0;
      }
      outbound.push(...valid);

      try {
        // drain the backlog first so events reach the Server in capture order
        const replayed = await opts.queue.replay(opts.send);
        if (replayed.droppedEvents > 0) {
          unreportedDrops += replayed.droppedEvents;
        }
        await opts.send(outbound);
        return "sent";
      } catch {
        const { droppedEvents } = opts.queue.enqueue(outbound);
        unreportedDrops += droppedEvents;
        return "queued";
      }
    },
  };
};
