import { isNormalEvent, sendEvents, type NormalEvent } from "@slopwatch/events";
import { createDiskQueue, createFlusher } from "@slopwatch/buffer";

export type ShipPipeline = {
  /**
   * Send a batch (v2 decision 21). In server mode a failed POST queues the
   * batch to a disk file beside the cursor and the caller advances the cursor:
   * the data lives in the queue, so capture does not depend on the
   * capture file surviving the outage. Queued batches replay oldest-first on
   * the next flush; hook fires also sweep all queue files. Only a failed
   * queue write itself falls back to exit-without-advancing.
   */
  flush(batch: NormalEvent[]): Promise<"sent" | "queued" | "stdout">;
};

/**
 * The shared ship path for a live-tailing listener: flusher + disk queue
 * wiring, identical for every agent. Without server credentials the pipeline
 * degenerates to stdout mode (normalized NDJSON).
 */
export const createShipPipeline = (opts: {
  agent: string;
  sessionId: string;
  serverUrl?: string;
  token?: string;
  /** State path base (cursor minus extension); the queue lives beside it. */
  stateBase: string;
  /** Called when a batch had to queue — the listener spawns a detached sweep. */
  onQueued?: () => void;
  /** Called per event that fails validation. Defaults to a one-line stderr
   * warning — without it stdout mode would drop invalid events silently. */
  onInvalid?: (event: unknown) => void;
}): ShipPipeline => {
  const reportInvalid =
    opts.onInvalid ??
    ((event: unknown) =>
      console.error(
        "live: skipping invalid event:",
        JSON.stringify(event).slice(0, 200),
      ));
  const shipFlush =
    opts.serverUrl && opts.token
      ? createFlusher({
          agent: opts.agent,
          sessionId: opts.sessionId,
          send: (events) =>
            sendEvents(events, {
              serverUrl: opts.serverUrl!,
              token: opts.token!,
            }),
          queue: createDiskQueue({ file: `${opts.stateBase}.queue.jsonl` }),
          onInvalid: reportInvalid,
        })
      : null;
  return {
    flush: async (batch) => {
      if (batch.length === 0) return "sent";
      if (shipFlush) {
        let result: "sent" | "queued";
        try {
          result = await shipFlush.flush(batch);
        } catch (e) {
          // the queue write itself failed (disk full?) — exit so a re-spawn
          // replays everything from the un-advanced cursor
          console.error(
            `live: could not queue batch (${e instanceof Error ? e.message : String(e)}) — exiting; re-spawn resumes from cursor`,
          );
          process.exit(1);
        }
        if (result === "queued") {
          console.error(
            "live: server unreachable — batch queued to disk for replay",
          );
          opts.onQueued?.();
        }
        return result;
      }
      for (const event of batch) {
        if (isNormalEvent(event)) console.log(JSON.stringify(event));
        else reportInvalid(event);
      }
      return "stdout";
    },
  };
};
