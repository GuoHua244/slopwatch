import { mkdirSync, openSync, readFileSync, rmSync } from "node:fs";

/** Options for {@link spawnDetachedListener}. */
export type SpawnDetachedListenerOptions = {
  /** Absolute path of the listener entry script (run with `process.execPath`). */
  scriptPath: string;
  /** Arguments after the script path. */
  args: string[];
  /** The child's stdout+stderr land here, appended. */
  logFile: string;
  /** Created recursively before the log file is opened. */
  logDir?: string;
};

/**
 * Spawn a listener that outlives the hook process: detached, its output
 * appended to the session's log file, unreferenced so the hook can exit
 * while the child keeps running. Returns the child's pid.
 */
export const spawnDetachedListener = (
  opts: SpawnDetachedListenerOptions,
): number => {
  if (opts.logDir) mkdirSync(opts.logDir, { recursive: true });
  const logFd = openSync(opts.logFile, "a");
  const child = Bun.spawn([process.execPath, opts.scriptPath, ...opts.args], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref?.();
  return child.pid;
};

/**
 * Parse a pid file: the trimmed number when it holds a plausible pid
 * (finite, positive), otherwise null — a missing or corrupt file is just
 * "no listener recorded".
 */
export const readPidFile = (path: string): number | null => {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

/** Best-effort removal of stale pid/heartbeat files (missing files are fine). */
export const removePidFiles = (...paths: string[]): void => {
  for (const path of paths) rmSync(path, { force: true });
};
