/**
 * Codex thread-writer lock watcher (v2 decision 30). Opening a thread in the
 * Codex app touches `~/.codex/thread-writer-locks/<thread-uuid>.lock` — the
 * only signal the app emits for "the user is now looking at this session"
 * (no hook fires, nothing is appended to the rollout, session_index and the
 * sidebar read-state stay put). The server watches the directory and echoes
 * each touch into the session's activity clock, so the dashboard's live dot
 * and newest-first order follow the user's attention. Optional by design:
 * the server may run on a host that never runs Codex (decision 26 compose),
 * where the directory is absent and the watcher stays off.
 */
import {
  existsSync,
  readdirSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Store } from "./store";

/**
 * The locks directory: `CODEX_LOCKS_DIR` verbatim, else inside `CODEX_HOME`,
 * else the default Codex home — the same `<CODEX_HOME|~/.codex>` convention
 * the codex listener uses for rollouts.
 */
export const codexLocksDir = (
  env: Record<string, string | undefined> = process.env,
): string =>
  env.CODEX_LOCKS_DIR ??
  join(env.CODEX_HOME ?? join(homedir(), ".codex"), "thread-writer-locks");

/** One `.lock` file name → its thread uuid; anything else is not a lock. */
const threadIdFrom = (name: string): string | null =>
  name.endsWith(".lock") && name.length > ".lock".length
    ? name.slice(0, -".lock".length)
    : null;

/** Current mtime per lock file; a vanished directory yields an empty map. */
const scanLocks = (dir: string): Map<string, number> => {
  const mtimes = new Map<string, number>();
  try {
    for (const name of readdirSync(dir)) {
      if (threadIdFrom(name) === null) continue;
      try {
        mtimes.set(name, statSync(join(dir, name)).mtimeMs);
      } catch {
        // raced a delete between readdir and stat — the file is gone, skip
      }
    }
  } catch {
    // directory missing or unreadable — nothing to scan this round
  }
  return mtimes;
};

export type CodexLockWatcher = {
  /** False when the directory does not exist — nothing is being watched. */
  active: boolean;
  /** One diff pass against the recorded baselines. Exposed for tests. */
  sweep(): void;
  stop(): void;
};

export const createCodexLockWatcher = (opts: {
  store: Pick<Store, "touchSession">;
  dir: string;
  /** Fallback sweep cadence alongside fs.watch. */
  pollMs?: number;
  log?: (message: string, error?: unknown) => void;
}): CodexLockWatcher => {
  const log = opts.log ?? console.error;
  if (!existsSync(opts.dir)) {
    log(
      `warning: ${opts.dir} does not exist — codex session-open activation is off`,
    );
    return { active: false, sweep: () => {}, stop: () => {} };
  }

  // Baseline only: a server restart must not replay every historical touch
  // as fresh activity — only changes observed while running bump.
  const baselines = scanLocks(opts.dir);

  const sweep = (): void => {
    const current = scanLocks(opts.dir);
    for (const [name, mtime] of current) {
      const prev = baselines.get(name);
      if (prev === mtime) continue;
      baselines.set(name, mtime);
      const threadId = threadIdFrom(name)!;
      void opts.store
        .touchSession(threadId)
        .catch((e: unknown) => log("codex lock touch failed:", e));
    }
    for (const name of baselines.keys())
      if (!current.has(name)) baselines.delete(name);
  };

  // fs.watch plus a slow poll, belt-and-braces (the codebuddy listener's
  // pattern): event payloads are unreliable on Windows, so both paths just
  // trigger a diff sweep that re-stats every lock it sees. Touches arrive in
  // bursts (app startup reopens the last thread) — coalesce into one sweep.
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  const scheduleSweep = (): void => {
    if (scheduled !== undefined) return;
    scheduled = setTimeout(() => {
      scheduled = undefined;
      sweep();
    }, 300);
  };
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(opts.dir, () => scheduleSweep());
    watcher.on("error", (e: unknown) =>
      log("codex lock watch error — falling back to polling:", e),
    );
  } catch (e) {
    log("codex lock watch unavailable — polling only:", e);
  }
  const poll = setInterval(sweep, opts.pollMs ?? 30_000);

  return {
    active: true,
    sweep,
    stop() {
      clearInterval(poll);
      if (scheduled !== undefined) clearTimeout(scheduled);
      watcher?.close();
    },
  };
};
