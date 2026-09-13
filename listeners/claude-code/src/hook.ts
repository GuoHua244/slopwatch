/**
 * Claude Code hook entry. Claude Code passes the hook payload as JSON on
 * stdin (no argv template expansion), so this script reads stdin, plans the
 * action, and returns immediately — SessionStart/UserPromptSubmit spawn the
 * transcript tailer detached, SessionEnd ships the session:end event and
 * tears the listener down. Prints nothing on stdout: SessionStart stdout
 * would be injected into the conversation as context.
 *
 * Usage (wired by install.ts): bun hook.ts --server-url U --token T
 *        bun hook.ts --stop --session-id <id>   (manual cleanup)
 */
import { execFileSync } from "node:child_process";
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
import { envelope, sendEvents, type SessionEndEvent } from "@slopwatch/events";
import { resolveShipConfig } from "@slopwatch/config";
import { createDiskQueue } from "@slopwatch/buffer";
import { argvHelpers, spawnDrainSweep } from "@slopwatch/listener-shared";

/** The per-session disk queue (v2 decision 21), beside the pid/log files. */
const queueFile = (sessionId: string): string =>
  join(logDir, `claude-code-${sessionId}.queue.jsonl`);

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
 * Pure dispatch planner: hook stdin payload → what to do. Claude Code
 * fires many hook events (PreToolUse, PostToolUse, Stop, …); only
 * SessionStart and UserPromptSubmit spawn, only SessionEnd ends.
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
    case "UserPromptSubmit": {
      if (typeof input.transcript_path !== "string" || !input.transcript_path) {
        return { kind: "none", reason: "no transcript_path in payload" };
      }
      return {
        kind: "spawn",
        sessionId,
        transcriptPath: input.transcript_path,
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
  join(logDir, `claude-code-${sessionId}.pid`);

const killStaleListener = (sessionId: string): void => {
  try {
    const pid = Number(readFileSync(pidFile(sessionId), "utf8").trim());
    if (Number.isFinite(pid) && pid > 0) process.kill(pid);
  } catch {
    // no pid file or already dead
  }
  rmSync(pidFile(sessionId), { force: true });
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
      ...envelope("claude-code", plan.sessionId, new Date().toISOString()),
      kind: "session",
      event: "end",
      ...(plan.reason ? { reason: plan.reason } : {}),
    };
    if (serverUrl && token) {
      try {
        await sendEvents([end], { serverUrl, token });
      } catch (e) {
        // v2 decision 21: the end event queues to disk instead of dying —
        // the hook is the ONLY sender of this event and the listener is being
        // torn down, so a sweep is spawned to ship it once the server answers
        console.error(
          `hook: session:end not delivered (${e instanceof Error ? e.message : String(e)}) — queueing`,
        );
        try {
          const queue = createDiskQueue({
            file: queueFile(plan.sessionId),
          });
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
    killStaleListener(plan.sessionId);
    process.exit(0);
  }

  // spawn — but skip when a listener for this session is already alive
  mkdirSync(logDir, { recursive: true });
  try {
    const pid = Number(readFileSync(pidFile(plan.sessionId), "utf8").trim());
    if (Number.isFinite(pid) && pid > 0) {
      process.kill(pid, 0);
      process.exit(0); // already running
    }
  } catch {
    // no pid file or stale pid — spawn a fresh listener
  }

  const liveTs = fileURLToPath(new URL("./live.ts", import.meta.url));
  const childArgs = [
    liveTs,
    "--file",
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
      // optional
    }
  }
  if (gitRemote) childArgs.push("--git-remote", gitRemote);

  const logFile = join(logDir, `claude-code-${plan.sessionId}.log`);
  const logFd = openSync(logFile, "a");
  const child = Bun.spawn([process.execPath, ...childArgs], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref?.();
  writeFileSync(pidFile(plan.sessionId), String(child.pid));
  // sweep any queue files stuck since earlier outages (v2 decision 21)
  sweep();
  console.error(
    `slopwatch listener spawned: pid=${child.pid} log=${logFile} transcript=${plan.transcriptPath}`,
  );
  process.exit(0);
};

if (import.meta.main) {
  void main();
}
