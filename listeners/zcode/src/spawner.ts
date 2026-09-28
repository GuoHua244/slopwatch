/**
 * ZCode SessionStart hook entry: spawn the live listener as a detached
 * process and return immediately — hooks run inline, so a slow hook blocks
 * the agent (zcode-guide). Also the --stop entry for cleanup/uninstall.
 *
 * Usage: bun spawner.ts --session-id <id> [--server-url U --token T]
 *                          [--idle-ms N] [--max-lifetime-ms N] [--log-dir D]
 *        bun spawner.ts --stop --session-id <id>
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@slopwatch/config";
import {
  argvHelpers,
  readPidFile,
  removePidFiles,
  spawnDetachedListener,
  spawnDrainSweep,
  isListenerAlive,
} from "@slopwatch/listener-shared";

const args = process.argv.slice(2);
const { arg } = argvHelpers(args);

const sessionId = arg("session-id");
if (!sessionId || sessionId.includes("${")) {
  // an unexpanded ${ZCODE_SESSION_ID} would spawn a listener polling a
  // rollout path that never exists — refuse instead
  console.error(
    "usage: bun spawner.ts --session-id <id> [--server-url U --token T] ...",
  );
  process.exit(1);
}

const logDir = arg("log-dir") ?? join(homedir(), ".slopwatch", "listeners");
const logFile = join(logDir, `zcode-${sessionId}.log`);
const pidFile = join(logDir, `zcode-${sessionId}.pid`);
const heartbeatFile = join(logDir, `zcode-${sessionId}.heartbeat`);

if (args.includes("--stop")) {
  const pid = readPidFile(pidFile);
  if (pid === null) {
    console.error("spawner: no pid file — not running");
    process.exit(0);
  }
  try {
    process.kill(pid);
    console.error(`spawner: stopped pid ${pid}`);
  } catch (e) {
    console.error(
      `spawner: pid ${pid} not running (${e instanceof Error ? e.message : e})`,
    );
  }
  removePidFiles(pidFile, heartbeatFile);
  process.exit(0);
}

// capture kill switch (`slopwatch pause`): before anything expensive, a
// paused install costs nothing but this config read
if (loadConfig()?.disabled) {
  console.error("slopwatch capture is paused — `slopwatch resume` re-enables");
  process.exit(0);
}

const zcodeHome = process.env.ZCODE_HOME ?? join(homedir(), ".zcode");
const rolloutFile = join(
  zcodeHome,
  "cli",
  "rollout",
  `model-io-${sessionId}.jsonl`,
);
const liveTs = fileURLToPath(new URL("./live.ts", import.meta.url));

// SessionStart also fires on resume/clear/compact — skip if a listener for
// this session is already alive: the PID exists AND its heartbeat is fresh.
// Signal-0 alone misreads Windows PID reuse as a live listener and would
// stall this session's capture forever.
const existingPid = readPidFile(pidFile);
if (
  existingPid !== null &&
  isListenerAlive({ pid: existingPid, heartbeatFile })
) {
  console.error(`slopwatch listener already running: pid=${existingPid}`);
  process.exit(0);
}

// Pin the hook process's cwd explicitly: the listener's session:start and its
// git-remote probe would otherwise silently depend on live.ts inheriting this
// process's working directory.
const childArgs = [
  "--file",
  rolloutFile,
  "--session-id",
  sessionId,
  "--cwd",
  process.cwd(),
];
if (arg("server-url")) childArgs.push("--server-url", arg("server-url")!);
if (arg("token")) childArgs.push("--token", arg("token")!);
if (arg("idle-ms")) childArgs.push("--idle-ms", arg("idle-ms")!);
if (arg("max-lifetime-ms"))
  childArgs.push("--max-lifetime-ms", arg("max-lifetime-ms")!);

const pid = spawnDetachedListener({
  scriptPath: liveTs,
  args: childArgs,
  logFile,
  logDir,
});

writeFileSync(pidFile, String(pid));
// make the newborn visible to the next spawner invocation before the
// listener's own first heartbeat lands (bun start can lag seconds under AV scans)
writeFileSync(heartbeatFile, String(Date.now()));
// sweep any queue files stuck since earlier outages (v2 decision 21) —
// including sessions that ended with the server down and have no listener
spawnDrainSweep(fileURLToPath(new URL("./drain.ts", import.meta.url)));
console.error(
  `slopwatch listener spawned: pid=${pid} log=${logFile} rollout=${rolloutFile}`,
);
process.exit(0);
