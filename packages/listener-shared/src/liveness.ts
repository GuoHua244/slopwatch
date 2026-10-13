import { statSync } from "node:fs";

/**
 * How long a listener's heartbeat is trusted after its last touch. Generous
 * enough for AV scans and machine sleep; small enough that a dead listener is
 * declared dead on the next user message.
 */
export const HEARTBEAT_TTL_MS = 5 * 60_000;

/**
 * True when a listener for this session is alive: its heartbeat file was
 * touched within the TTL. The listener touches it at boot and every 30s, and
 * the spawner pre-writes it at spawn so a just-started generation is visible
 * immediately.
 *
 * This used to also require the recorded PID to exist (signal-0). The probe
 * is gone on purpose: on Windows (Bun 1.4.2 measured) the FIRST
 * `process.kill(pid, 0)` of a fresh process against an existing foreign
 * process costs ~3s (Node: ~3ms), and hooks run inline — every hook fire is
 * a fresh process, so SessionStart stalled opening a session by that long.
 * The heartbeat alone is the liveness proof the spawner acts on; the trade
 * is that a listener which crashes before its first heartbeat stays
 * "alive" for at most one TTL — capture lags, never loses data, because the
 * respawn backfills from the cursor.
 */
export const isListenerAlive = (opts: {
  heartbeatFile: string;
  nowMs?: number;
}): boolean => {
  try {
    const age =
      (opts.nowMs ?? Date.now()) - statSync(opts.heartbeatFile).mtimeMs;
    return age < HEARTBEAT_TTL_MS;
  } catch {
    return false;
  }
};
