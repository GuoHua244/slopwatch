/**
 * CodeBuddy hook entry. CodeBuddy passes the hook payload as JSON on stdin
 * (CC-compatible: `session_id`, `transcript_path`, `cwd`, `hook_event_name`,
 * plus `tool_name` for tool events), so this script reads stdin, plans the
 * action, and returns immediately — SessionStart/UserPromptSubmit/PostToolUse
 * spawn the history tailer detached, SessionEnd would ship session:end and
 * request a graceful stop (never observed to fire on the measured build, which
 * is why `live.ts` also ends on idle).
 *
 * Two payload traps handled here rather than downstream:
 * - `cwd` is the *editor install directory* on this build, so it is NOT
 *   trusted — `live.ts` re-derives it from the transcript path and the IDE's
 *   own workspace records;
 * - `transcript_path` points at a manifest that is rewritten whole, so the
 *   listener drains it by row watermark, not by byte cursor over lines.
 *
 * Prints nothing on stdout: SessionStart stdout would be injected into the
 * conversation as context.
 *
 * Usage (wired by install.ts): bun hook.ts --server-url U --token T
 *        bun hook.ts --stop --session-id <id>   (manual cleanup)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { envelope, sendEvents, type SessionEndEvent } from "@slopwatch/events";
import { loadConfig, resolveShipConfig } from "@slopwatch/config";
import { createDiskQueue } from "@slopwatch/buffer";
import {
  argvHelpers,
  readPidFile,
  removePidFiles,
  spawnDetachedListener,
  spawnDrainSweep,
  isListenerAlive,
} from "@slopwatch/listener-shared";
import { AGENT } from "./normalizer";

/** The per-session disk queue (v2 decision 21), beside the pid/log files. */
const queueFile = (sessionId: string): string =>
  join(logDir, `${AGENT}-${sessionId}.queue.jsonl`);

/** Detached sweep of every stuck queue file in the state dir. */
const sweep = (): void =>
  spawnDrainSweep(fileURLToPath(new URL("./drain.ts", import.meta.url)));

export type HookPlan =
  | {
      kind: "spawn";
      sessionId: string;
      transcriptPath: string;
      cwd?: string;
    }
  | { kind: "end"; sessionId: string; reason?: string }
  | { kind: "none"; reason: string };

/**
 * Pure dispatch planner: hook stdin payload → what to do.
 *
 * `PostToolUse` is the load-bearing one: this host fires it once per tool
 * call and nothing reliable at the end of a turn, so it doubles as the
 * re-spawn heartbeat that decision 19 introduced for ZCode — a listener that
 * idle-exited mid-tool-loop comes back within one tool call instead of
 * waiting for the next prompt.
 */
export const planHook = (hookInput: unknown): HookPlan => {
  if (typeof hookInput !== "object" || hookInput === null) {
    return { kind: "none", reason: "payload is not an object" };
  }
  const input = hookInput as Record<string, unknown>;
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return { kind: "none", reason: "no session_id in payload" };
  }
  switch (input.hook_event_name) {
    case "SessionStart":
    case "UserPromptSubmit":
    case "PostToolUse": {
      if (typeof input.transcript_path !== "string" || !input.transcript_path) {
        return { kind: "none", reason: "no transcript_path in payload" };
      }
      return {
        kind: "spawn",
        sessionId,
        transcriptPath: input.transcript_path,
        // advisory only: this host reports the IDE install dir, and live.ts
        // replaces it with the workspace it can prove from the transcript
        cwd: typeof input.cwd === "string" && input.cwd ? input.cwd : undefined,
      };
    }
    case "SessionEnd":
      return {
        kind: "end",
        sessionId,
        reason: typeof input.reason === "string" ? input.reason : undefined,
      };
    default:
      return {
        kind: "none",
        reason: `unhandled event ${String(input.hook_event_name)}`,
      };
  }
};

const args = process.argv.slice(2);
const { arg } = argvHelpers(args);

const readStdinJson = async (): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const logDir = join(homedir(), ".slopwatch", "listeners");
const pidFile = (sessionId: string): string =>
  join(logDir, `${AGENT}-${sessionId}.pid`);
const heartbeatFile = (sessionId: string): string =>
  join(logDir, `${AGENT}-${sessionId}.heartbeat`);
/** The graceful-stop marker the live listener consumes on its tick cadence. */
const stopFile = (sessionId: string): string =>
  join(logDir, `${AGENT}-${sessionId}.stop`);

const killStaleListener = (sessionId: string): void => {
  const pid = readPidFile(pidFile(sessionId));
  if (
    pid !== null &&
    isListenerAlive({ pid, heartbeatFile: heartbeatFile(sessionId) })
  ) {
    process.kill(pid);
  }
  removePidFiles(pidFile(sessionId), heartbeatFile(sessionId));
};

/**
 * End-of-session teardown: request a graceful stop when a listener is alive
 * and return at once — the listener (detached) flushes its held-back model
 * requests and its summary fold into its own end batch, then exits. A hard
 * kill here would lose exactly the end-of-session data capture exists for
 * (and Windows cannot deliver SIGTERM to a detached process anyway, ADR 0001).
 */
const requestGracefulStop = (sessionId: string): void => {
  const pid = readPidFile(pidFile(sessionId));
  if (
    pid !== null &&
    isListenerAlive({ pid, heartbeatFile: heartbeatFile(sessionId) })
  ) {
    try {
      writeFileSync(stopFile(sessionId), String(Date.now()));
      return;
    } catch {
      // fall through to the hard kill — capture must not linger
    }
  }
  killStaleListener(sessionId);
};

const main = async (): Promise<void> => {
  if (args.includes("--stop")) {
    const sessionId = arg("session-id");
    if (!sessionId) {
      console.error("usage: bun hook.ts --stop --session-id <id>");
      process.exit(1);
    }
    killStaleListener(sessionId);
    process.exit(0);
  }

  // capture kill switch (`slopwatch pause`): a paused install costs nothing
  // but this config read — no spawn, no end event
  if (loadConfig()?.disabled) {
    console.error(
      "slopwatch capture is paused — `slopwatch resume` re-enables",
    );
    process.exit(0);
  }

  const plan = planHook(await readStdinJson());
  if (plan.kind === "none") {
    console.error(`hook: ignoring event (${plan.reason})`);
    process.exit(0);
  }

  // argv pair wins; otherwise the central config written by `slopwatch
  // install` — the installed hook command itself carries no credentials
  const ship = resolveShipConfig({
    serverUrl: arg("server-url"),
    token: arg("token"),
  });
  const serverUrl = ship?.serverUrl;
  const token = ship?.token;

  if (plan.kind === "end") {
    const end: SessionEndEvent = {
      ...envelope(AGENT, plan.sessionId, new Date().toISOString()),
      kind: "session",
      event: "end",
      ...(plan.reason ? { reason: plan.reason } : {}),
    };
    if (serverUrl && token) {
      try {
        // 3s: the hook budget is 10s — a hung send must fail into the
        // queue-and-sweep path, not burn the budget and get killed
        await sendEvents([end], { serverUrl, token, timeoutMs: 3000 });
      } catch (e) {
        // v2 decision 21: the end event queues to disk instead of dying
        console.error(
          `hook: session:end not delivered (${e instanceof Error ? e.message : String(e)}) — queueing`,
        );
        try {
          const queue = createDiskQueue({ file: queueFile(plan.sessionId) });
          const { droppedEvents } = queue.enqueue([end]);
          if (droppedEvents > 0) {
            console.error(
              `hook: queue overflow dropped ${droppedEvents} events`,
            );
          }
          sweep();
        } catch (e2) {
          console.error(
            `hook: session:end lost — queueing failed (${e2 instanceof Error ? e2.message : String(e2)})`,
          );
        }
      }
    } else {
      console.log(JSON.stringify(end));
    }
    requestGracefulStop(plan.sessionId);
    process.exit(0);
  }

  // spawn — but skip when a listener for this session is already alive.
  // The heartbeat is the liveness proof: signal-0 alone mistakes a
  // PID-reuse stranger for our listener and capture would stall.
  mkdirSync(logDir, { recursive: true });
  const existingPid = readPidFile(pidFile(plan.sessionId));
  if (
    existingPid !== null &&
    isListenerAlive({
      pid: existingPid,
      heartbeatFile: heartbeatFile(plan.sessionId),
    })
  ) {
    process.exit(0); // already running
  }
  // a stop marker left behind by a listener that died before consuming it
  // must not insta-finish the generation we are about to spawn
  removePidFiles(stopFile(plan.sessionId));

  const liveTs = fileURLToPath(new URL("./live.ts", import.meta.url));
  const childArgs = [
    "--transcript-path",
    plan.transcriptPath,
    "--session-id",
    plan.sessionId,
  ];
  if (plan.cwd) childArgs.push("--cwd", plan.cwd);
  if (serverUrl) childArgs.push("--server-url", serverUrl);
  if (token) childArgs.push("--token", token);
  if (arg("idle-ms")) childArgs.push("--idle-ms", arg("idle-ms")!);
  if (arg("max-lifetime-ms"))
    childArgs.push("--max-lifetime-ms", arg("max-lifetime-ms")!);

  let gitRemote: string | undefined;
  if (plan.cwd) {
    try {
      gitRemote = execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: plan.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      // optional — plan.cwd is the IDE's own directory on this build anyway
    }
  }
  if (gitRemote) childArgs.push("--git-remote", gitRemote);

  const logFile = join(logDir, `${AGENT}-${plan.sessionId}.log`);
  const pid = spawnDetachedListener({
    scriptPath: liveTs,
    args: childArgs,
    logFile,
    logDir,
  });
  writeFileSync(pidFile(plan.sessionId), String(pid));
  // make the newborn visible before its own first heartbeat lands — the next
  // hook fire would otherwise read a dead liveness signal and spawn a second
  // listener onto the same conversation
  writeFileSync(heartbeatFile(plan.sessionId), String(Date.now()));
  // sweep any queue files stuck since earlier outages (v2 decision 21)
  sweep();
  console.error(
    `slopwatch listener spawned: pid=${pid} log=${logFile} history=${plan.transcriptPath}`,
  );
  process.exit(0);
};

if (import.meta.main) {
  void main();
}
