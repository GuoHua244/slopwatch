/**
 * ZCode SessionStart hook entry: spawn the live listener as a detached
 * process and return immediately — hooks run inline, so a slow hook blocks
 * the agent (zcode-guide). Also the --stop entry for cleanup/uninstall.
 *
 * Usage: bun spawner.ts --session-id <id> [--server-url U --token T]
 *                          [--idle-ms N] [--max-lifetime-ms N] [--log-dir D]
 *        bun spawner.ts --stop --session-id <id>
 */
import {
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const sessionId = arg("session-id");
if (!sessionId) {
  console.error(
    "usage: bun spawner.ts --session-id <id> [--server-url U --token T] ...",
  );
  process.exit(1);
}

const logDir = arg("log-dir") ?? join(homedir(), ".slopwatch", "listeners");
const logFile = join(logDir, `zcode-${sessionId}.log`);
const pidFile = join(logDir, `zcode-${sessionId}.pid`);

if (args.includes("--stop")) {
  let pid: number | undefined;
  try {
    pid = Number(readFileSync(pidFile, "utf8").trim());
  } catch {
    console.log("spawner: no pid file — not running");
    process.exit(0);
  }
  try {
    process.kill(pid);
    console.log(`spawner: stopped pid ${pid}`);
  } catch (e) {
    console.log(
      `spawner: pid ${pid} not running (${e instanceof Error ? e.message : e})`,
    );
  }
  rmSync(pidFile, { force: true });
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

mkdirSync(logDir, { recursive: true });
const logFd = openSync(logFile, "a");

const childArgs = [liveTs, "--file", rolloutFile, "--session-id", sessionId];
if (arg("server-url")) childArgs.push("--server-url", arg("server-url")!);
if (arg("token")) childArgs.push("--token", arg("token")!);
if (arg("idle-ms")) childArgs.push("--idle-ms", arg("idle-ms")!);
if (arg("max-lifetime-ms"))
  childArgs.push("--max-lifetime-ms", arg("max-lifetime-ms")!);

const child = Bun.spawn([process.execPath, ...childArgs], {
  detached: true,
  stdio: ["ignore", logFd, logFd],
});
child.unref?.();

writeFileSync(pidFile, String(child.pid));
console.log(
  `slopwatch listener spawned: pid=${child.pid} log=${logFile} rollout=${rolloutFile}`,
);
process.exit(0);
