import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replayQueueFiles } from "@slopwatch/buffer";
import type { NormalEvent } from "@slopwatch/events";

/**
 * Fire-and-forget sweep of every stuck queue file — when a session truly ends
 * with the server still down, nothing respawns, so the sweep is what
 * eventually ships the queued batches. Best effort: a failed spawn just waits
 * for the next hook fire to sweep again.
 */
export const spawnDrainSweep = (drainTs: string): void => {
  try {
    const child = Bun.spawn([process.execPath, drainTs], {
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    child.unref?.();
  } catch {
    // best effort — the next hook fire sweeps again
  }
};

export const runQueueSweep = async (opts: {
  agent: string;
  stateDir: string;
  send: (events: NormalEvent[]) => Promise<void>;
  /**
   * Whether the queue's owning session is alive right now — a live owner
   * replays its own queue on every flush, and a concurrent sweep would
   * interleave appends and tear lines (found in E2E: buffer-overflow reports
   * with no real overflow). Only orphans get swept. Default: signal-0 probe.
   */
  ownerAlive?: (sessionId: string, pid: number) => boolean;
}) => {
  const pattern = new RegExp(`^${opts.agent}-(.*)\\.queue\\.jsonl$`);
  return replayQueueFiles({
    dir: opts.stateDir,
    pattern,
    send: opts.send,
    skip: (name) => {
      const sessionId = name.replace(pattern, "$1");
      try {
        const pid = Number(
          readFileSync(
            join(opts.stateDir, `${opts.agent}-${sessionId}.pid`),
            "utf8",
          ).trim(),
        );
        if (!(Number.isFinite(pid) && pid > 0)) return false;
        if (!opts.ownerAlive) {
          process.kill(pid, 0); // throws ESRCH when the pid is dead
          return true;
        }
        return opts.ownerAlive(sessionId, pid);
      } catch {
        return false; // no pid file or dead pid — orphan, sweep it
      }
    },
  });
};
