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
};

/**
 * The shared tail loop: read new bytes, stitch partial lines, parse,
 * quarantine, hand records to the adapter, feed the turn digest, flush, and
 * commit the cursor only after a successful send. Cursor state resumes from
 * the previous generation's offset (0 on first capture).
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
    } finally {
      draining = false;
    }
  };
  return { drain };
};
