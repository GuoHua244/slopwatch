/**
 * Queue sweep (v2 decision 21): replay every stuck zcode queue file in the
 * listener state dir. Spawned detached by the spawner on every hook fire and
 * by a sidecar whose flush had to queue — the orphan-drain path for sessions
 * that ended while the Server was down and have no sidecar left to respawn.
 *
 * Usage: bun drain.ts [--server-url U --token T]
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { sendEvents } from "@slopwatch/events";
import { resolveShipConfig } from "@slopwatch/config";
import { replayQueueFiles } from "@slopwatch/buffer";
import { isSidecarAlive } from "./liveness";

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const ship = resolveShipConfig({
  serverUrl: arg("server-url"),
  token: arg("token"),
});
if (!ship) {
  process.exit(0); // stdout mode has no queues
}

const stateDir = join(homedir(), ".slopwatch", "listeners");
const result = await replayQueueFiles({
  dir: stateDir,
  pattern: /^zcode-.*\.queue\.jsonl$/,
  send: (events) => sendEvents(events, ship),
  // a live sidecar replays its own queue on every flush — a concurrent
  // sweep here would interleave appends and tear lines (found in E2E:
  // buffer-overflow reports with no real overflow). Only orphans get swept.
  skip: (name) => {
    const sessionId = name.replace(/^zcode-(.*)\.queue\.jsonl$/, "$1");
    try {
      const pid = Number(
        readFileSync(join(stateDir, `zcode-${sessionId}.pid`), "utf8").trim(),
      );
      if (!(Number.isFinite(pid) && pid > 0)) return false;
      return isSidecarAlive({
        pid,
        heartbeatFile: join(stateDir, `zcode-${sessionId}.heartbeat`),
      });
    } catch {
      return false; // no pid file — orphan, sweep it
    }
  },
});
if (result.sentEvents > 0 || result.skipped > 0) {
  console.error(
    `drain: replayed ${result.sentEvents} queued events from ${result.files} file(s), skipped ${result.skipped} live`,
  );
}
