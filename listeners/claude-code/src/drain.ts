/**
 * Queue sweep (v2 decision 21): replay every stuck claude-code queue file in
 * the listener state dir. Spawned detached by the hook on every fire and
 * after an undeliverable session:end — the orphan-drain path for sessions
 * that ended while the Server was down.
 *
 * Usage: bun drain.ts [--server-url U --token T]
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { sendEvents } from "@slopwatch/events";
import { resolveShipConfig } from "@slopwatch/config";
import { argvHelpers, runQueueSweep } from "@slopwatch/listener-shared";

const { arg } = argvHelpers(process.argv.slice(2));

const ship = resolveShipConfig({
  serverUrl: arg("server-url"),
  token: arg("token"),
});
if (!ship) {
  process.exit(0); // stdout mode has no queues
}

const stateDir = join(homedir(), ".slopwatch", "listeners");
const result = await runQueueSweep({
  agent: "claude-code",
  stateDir,
  send: (events) => sendEvents(events, ship),
  // the pid file is the liveness proof (signal-0 probe)
});
if (result.sentEvents > 0 || result.skipped > 0) {
  console.error(
    `drain: replayed ${result.sentEvents} queued events from ${result.files} file(s), skipped ${result.skipped} live`,
  );
}
