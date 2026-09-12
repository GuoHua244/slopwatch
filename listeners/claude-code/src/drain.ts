/**
 * Queue sweep (v2 decision 21): replay every stuck claude-code queue file in
 * the listener state dir. Spawned detached by the hook on every fire and
 * after an undeliverable session:end — the orphan-drain path for sessions
 * that ended while the Server was down.
 *
 * Usage: bun drain.ts [--server-url U --token T]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sendEvents } from "@slopwatch/events";
import { resolveShipConfig } from "@slopwatch/config";
import { replayQueueFiles } from "@slopwatch/buffer";

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
  pattern: /^claude-code-.*\.queue\.jsonl$/,
  send: (events) => sendEvents(events, ship),
  // a live sidecar replays its own queue on every flush — a concurrent
  // sweep here would interleave appends and tear lines. Only orphans get
  // swept; the pid file is the liveness proof (signal-0).
  skip: (name) => {
    const sessionId = name.replace(/^claude-code-(.*)\.queue\.jsonl$/, "$1");
    try {
      const pid = Number(
        readFileSync(
          join(stateDir, `claude-code-${sessionId}.pid`),
          "utf8",
        ).trim(),
      );
      if (!(Number.isFinite(pid) && pid > 0)) return false;
      process.kill(pid, 0);
      return true;
    } catch {
      return false; // no pid file or dead pid — orphan, sweep it
    }
  },
});
if (result.sentEvents > 0 || result.skipped > 0) {
  console.error(
    `drain: replayed ${result.sentEvents} queued events from ${result.files} file(s), skipped ${result.skipped} live`,
  );
}
