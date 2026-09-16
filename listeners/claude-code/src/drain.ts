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
import { argvHelpers, runAgentDrain } from "@slopwatch/listener-shared";
import { isListenerAlive } from "./liveness";

const { arg } = argvHelpers(process.argv.slice(2));

const ship = resolveShipConfig({
  serverUrl: arg("server-url"),
  token: arg("token"),
});
if (!ship) {
  process.exit(0); // stdout mode has no queues
}

const stateDir = join(homedir(), ".slopwatch", "listeners");
await runAgentDrain({
  agent: "claude-code",
  stateDir,
  send: (events) => sendEvents(events, ship),
  // the heartbeat file is the liveness proof — Windows reuses PIDs, so
  // signal-0 alone can mistake a dead listener for a live one and skip
  // an orphaned queue on every sweep
  ownerAlive: (sessionId, pid) =>
    isListenerAlive({
      pid,
      heartbeatFile: join(stateDir, `claude-code-${sessionId}.heartbeat`),
    }),
});
