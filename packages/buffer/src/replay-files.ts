/**
 * Sweep every queue file in the listener state dir and replay it — the
 * orphan-drain path (v2 decision 21). A session that truly ended can leave
 * batches queued with no sidecar left to respawn; any later hook fire in any
 * session spawns this sweep, which ships the stuck batches (e.g. the
 * session:end the hook could not deliver) and empties the files.
 *
 * `skip` lets the caller leave LIVE sidecars' queues alone: a running
 * sidecar replays its own queue on every flush, and a concurrent rewrite
 * here would interleave with its appends and tear lines.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { NormalEvent } from "@slopwatch/events";
import { createDiskQueue } from "./disk-queue";

export const replayQueueFiles = async (opts: {
  dir: string;
  pattern: RegExp;
  send: (events: NormalEvent[]) => Promise<void>;
  /** Return true for queue files owned by a live sidecar — they are skipped. */
  skip?: (queueFileName: string) => boolean;
}): Promise<{ files: number; sentEvents: number; skipped: number }> => {
  if (!existsSync(opts.dir)) return { files: 0, sentEvents: 0, skipped: 0 };
  let files = 0;
  let sentEvents = 0;
  let skipped = 0;
  for (const name of readdirSync(opts.dir)) {
    if (!opts.pattern.test(name)) continue;
    if (opts.skip?.(name)) {
      skipped += 1;
      continue;
    }
    const queue = createDiskQueue({ file: join(opts.dir, name) });
    const stats = queue.stats();
    if (stats.entries === 0) continue;
    const result = await queue.replay(opts.send);
    if (result.sentEvents > 0) files += 1;
    sentEvents += result.sentEvents;
  }
  return { files, sentEvents, skipped };
};
