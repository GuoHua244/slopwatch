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

const result = await replayQueueFiles({
  dir: join(homedir(), ".slopwatch", "listeners"),
  pattern: /^zcode-.*\.queue\.jsonl$/,
  send: (events) => sendEvents(events, ship),
});
if (result.sentEvents > 0) {
  console.error(
    `drain: replayed ${result.sentEvents} queued events from ${result.files} file(s)`,
  );
}
