import { statSync } from "node:fs";

/**
 * How long a sidecar's heartbeat is trusted after its last touch. Generous
 * enough for AV scans and machine sleep; small enough that a dead sidecar is
 * declared dead on the next user message.
 */
export const HEARTBEAT_TTL_MS = 5 * 60_000;

/**
 * True when a sidecar for this session is alive: the PID exists AND the
 * sidecar's heartbeat file was touched within the TTL. Signal-0 alone is not
 * enough on Windows — PIDs are reused within minutes, so a dead sidecar's PID
 * can belong to a stranger and the spawner would skip respawning forever,
 * silently stalling that session's capture. A missing or stale heartbeat
 * therefore means "not alive", including sidecars from before heartbeats
 * existed.
 */
export const isSidecarAlive = (opts: {
  pid: number;
  heartbeatFile: string;
  nowMs?: number;
}): boolean => {
  try {
    process.kill(opts.pid, 0);
  } catch {
    return false;
  }
  try {
    const age =
      (opts.nowMs ?? Date.now()) - statSync(opts.heartbeatFile).mtimeMs;
    return age < HEARTBEAT_TTL_MS;
  } catch {
    return false;
  }
};
