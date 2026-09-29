import { closeSync, openSync, readSync, statSync } from "node:fs";
import { quarantineLine, type NormalEvent } from "@slopwatch/events";
import { readCursor, writeCursor } from "./cursor";
import type { TurnDigest } from "./turn-digest";

/**
 * The per-agent part of live-tailing: how a parsed capture record turns into
 * normalized events, and whether its shape drifted from the documented
 * contract (drift is quarantined verbatim, not dropped).
 */
export type RecordAdapter = {
  driftFromRecord(record: unknown): string | null;
  eventsFromRecord(record: unknown, sessionId: string): NormalEvent[];
  /**
   * Events the adapter is still holding back at teardown — an aggregator
   * (Claude Code buffers one model_request across its per-block records)
   * flushes what would otherwise die with the process. Runs once, just
   * before the session's end event ships.
   */
  onTeardown?(): NormalEvent[];
  /**
   * Delivery acks for a drain's batch: onFlushed after the flush succeeded
   * AND the cursor committed, onFlushFailed when the drain aborted at any
   * point after events were normalized (flush rejected, cursor write failed,
   * a later record threw). Adapters that gate emissions on delivery — the
   * session-title gate — commit their gate only on the ack: committing at
   * normalization time would permanently suppress a title whose batch never
   * shipped. The order (cursor first, ack second) makes the window between
   * them at-least-once: a crash there re-ships a title, never loses one.
   */
  onFlushed?(batch: NormalEvent[]): void;
  onFlushFailed?(batch: NormalEvent[]): void;
};

/**
 * The shared tail loop: read new bytes, stitch partial lines, parse,
 * quarantine, hand records to the adapter, feed the turn digest, flush, and
 * commit the cursor only after a successful send. Cursor state resumes from
 * the previous generation's offset (0 on first capture).
 *
 * Shrink is detected and resets the read; a rewrite that keeps or grows the
 * size is not — the resume then starts mid-record and that first fragment
 * lands in the quarantine as a mid-JSON suffix. Accepted by design (verbatim
 * evidence, nothing lost); a resync protocol would need dedup groundwork to
 * avoid re-emitting whole sessions.
 */
export const createTailLoop = (opts: {
  file: string;
  cursorFile: string;
  agent: string;
  sessionId: string;
  adapter: RecordAdapter;
  digest: TurnDigest;
  flush: (batch: NormalEvent[]) => Promise<unknown>;
  resetIdle: () => void;
}): { drain: () => Promise<void> } => {
  let size = readCursor(opts.cursorFile);
  let partial = "";
  let draining = false;
  const drain = async (): Promise<void> => {
    if (draining) return; // previous flush still in flight
    draining = true;
    try {
      let current: number;
      try {
        current = statSync(opts.file).size;
      } catch {
        return; // file vanished (rotated?) — keep waiting
      }
      if (current < size) {
        size = 0; // file truncated/rotated — start over
        partial = "";
      }
      if (current === size) return;
      const fd = openSync(opts.file, "r");
      const buf = Buffer.alloc(current - size);
      readSync(fd, buf, 0, buf.length, size);
      closeSync(fd);
      size = current;
      partial += buf.toString("utf8");
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      const batch: NormalEvent[] = [];
      try {
        for (const line of lines) {
          if (!line.trim()) continue;
          let record: unknown;
          try {
            record = JSON.parse(line);
          } catch {
            // v2 decision 21: unparsable lines are quarantined, not dropped —
            // the verbatim text reaches the Server's quarantine store
            batch.push(
              quarantineLine({
                agent: opts.agent,
                session_id: opts.sessionId,
                reason: "unparsable json",
                line,
              }),
            );
            opts.resetIdle();
            continue;
          }
          const drift = opts.adapter.driftFromRecord(record);
          if (drift !== null) {
            batch.push(
              quarantineLine({
                agent: opts.agent,
                session_id: opts.sessionId,
                reason: drift,
                line,
              }),
            );
          }
          const events = opts.adapter.eventsFromRecord(record, opts.sessionId);
          batch.push(...events);
          opts.digest.observe(events);
          opts.resetIdle();
        }
        await opts.flush(batch);
        // committed only AFTER a successful send, and only up to the end of the
        // last COMPLETE line — a partially-written trailing line is re-read next
        // time so it can be stitched back together
        writeCursor(opts.cursorFile, size - Buffer.byteLength(partial));
        // the delivery ack lands after the cursor commit (see RecordAdapter)
        opts.adapter.onFlushed?.(batch);
      } catch (e) {
        // events already normalized may have gated future emissions —
        // release those gates so the retry re-emits them
        if (batch.length > 0) opts.adapter.onFlushFailed?.(batch);
        // A transient I/O failure (an antivirus lock on Windows, a disk
        // hiccup) must not escape as an unhandled rejection — the callers
        // `void drain()` from watch/interval callbacks, so a throw would kill
        // the listener silently and stall the session's capture. The cursor
        // only ever advances on success, so the next tick simply retries.
        console.error(
          `tail: drain failed, will retry (${e instanceof Error ? e.message : String(e)})`,
        );
      }
    } finally {
      draining = false;
    }
  };
  return { drain };
};
