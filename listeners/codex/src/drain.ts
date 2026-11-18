/**
 * Queue sweep (v2 decision 21): replay every stuck codex queue file in the
 * listener state dir. Spawned detached by the hook on every fire and by a
 * listener whose flush had to queue — the orphan-drain path for sessions
 * that ended while the Server was down and have no listener left to respawn.
 *
 * Usage: bun drain.ts [--server-url U --token T]
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { sendEvents } from "@slopwatch/events";
import { resolveShipConfig } from "@slopwatch/config";
import {
  argvHelpers,
  isListenerAlive,
  runAgentDrain,
} from "@slopwatch/listener-shared";

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
  agent: "codex",
  stateDir,
  send: (events) => sendEvents(events, ship),
  // the heartbeat file is the liveness proof — a stale heartbeat means the
  // session's listener (if any) is gone and the queue is orphaned
  ownerAlive: (sessionId) =>
    isListenerAlive({
      heartbeatFile: join(stateDir, `codex-${sessionId}.heartbeat`),
    }),
});
