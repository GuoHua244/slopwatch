import { readFileSync } from "node:fs";
import { homedir } from "node:os";
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
      let pid: number;
      try {
        pid = Number(
          readFileSync(
            join(opts.stateDir, `${opts.agent}-${sessionId}.pid`),
            "utf8",
          ).trim(),
        );
      } catch {
        return false; // no pid file — orphan, sweep it
      }
      if (!(Number.isFinite(pid) && pid > 0)) return false;
      if (opts.ownerAlive) return opts.ownerAlive(sessionId, pid);
      try {
        process.kill(pid, 0); // ESRCH: the pid is gone
      } catch (e) {
        // EPERM: the pid exists but belongs to another account — it is alive
        // as far as we can tell, and a live owner's queue must never be
        // swept mid-append, so only a definite absence counts as dead.
        return (e as NodeJS.ErrnoException)?.code !== "EPERM";
      }
      return true;
    },
  });
};

/**
 * One agent's orphan-drain run, shared by both listeners' drain.ts: sweep the
 * state dir's stuck queue files with the given ship config and report what
 * happened. The queue-replay entry the hooks spawn detached.
 */
export const runAgentDrain = async (opts: {
  agent: string;
  /** Defaults to the shared per-user listener state dir. */
  stateDir?: string;
  send: (events: NormalEvent[]) => Promise<void>;
  ownerAlive?: (sessionId: string, pid: number) => boolean;
}): Promise<void> => {
  const stateDir = opts.stateDir ?? join(homedir(), ".slopwatch", "listeners");
  const result = await runQueueSweep({
    agent: opts.agent,
    stateDir,
    send: opts.send,
    ownerAlive: opts.ownerAlive,
  });
  if (result.sentEvents > 0 || result.skipped > 0) {
    console.error(
      `drain: replayed ${result.sentEvents} queued events from ${result.files} file(s), skipped ${result.skipped} live`,
    );
  }
};
