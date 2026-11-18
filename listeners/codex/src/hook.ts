/**
 * Codex hook entry. Codex passes the hook payload as JSON on stdin
 * (snake_case: session_id / transcript_path / cwd / hook_event_name), so
 * this script reads stdin, plans the action, and returns immediately —
 * SessionStart/UserPromptSubmit/PostToolUse/Stop spawn the rollout tailer
 * detached (PostToolUse and Stop re-spawn mid-turn after an idle exit,
 * mirroring the decision-19 fix), SessionEnd ships the session:end event and
 * requests a graceful listener stop — the detached listener outlives the
 * hook just long enough to flush its final model request and the summary
 * fold, which a hard kill would lose (and Windows cannot deliver SIGTERM to
 * a detached process anyway, ADR 0001). Prints nothing on stdout:
 * SessionStart stdout would be injected into the conversation as context,
 * and even in stdout mode the session:end NDJSON goes to stderr for the
 * same reason.
 *
 * Handler budget: Codex clamps SessionEnd hooks to 3s (default 1s) — the
 * installer pins timeout: 3, the end POST gets 2s, and a failed send queues
 * to the per-session disk queue for the sweep.
 *
 * Usage (wired by install.ts): bun hook.ts
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

const logDir = join(homedir(), ".slopwatch", "listeners");

/** The per-session disk queue (v2 decision 21), beside the pid/log files. */
const queueFile = (sessionId: string): string =>
  join(logDir, `codex-${sessionId}.queue.jsonl`);

/** Detached sweep of every stuck queue file. */
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
 * Pure dispatch planner: hook stdin payload → what to do. Codex fires many
 * hook events (PreToolUse, PermissionRequest, SubagentStart, …);
 * SessionStart, UserPromptSubmit, PostToolUse, and Stop spawn, only
 * SessionEnd ends. Stop matters because a turn can outlast the listener's
 * idle window after a mid-turn idle exit — the next prompt alone would not
 * bring the listener back for everything the agent finished meanwhile.
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
    case "PostToolUse":
    case "Stop": {
      if (typeof input.transcript_path !== "string" || !input.transcript_path) {
        // a non-local thread store reports no rollout path — nothing to tail
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

const pidFile = (sessionId: string): string =>
  join(logDir, `codex-${sessionId}.pid`);
const heartbeatFile = (sessionId: string): string =>
  join(logDir, `codex-${sessionId}.heartbeat`);
/** The graceful-stop marker the live listener consumes on its tick cadence. */
const stopFile = (sessionId: string): string =>
  join(logDir, `codex-${sessionId}.stop`);

const killStaleListener = (sessionId: string): void => {
  const pid = readPidFile(pidFile(sessionId));
  // The heartbeat is the liveness proof — Windows reuses PIDs, so a bare
  // signal-0 kill can terminate an unrelated process that inherited the
  // PID after our listener died.
  if (
    pid !== null &&
    isListenerAlive({ heartbeatFile: heartbeatFile(sessionId) })
  ) {
    process.kill(pid);
  }
  removePidFiles(pidFile(sessionId), heartbeatFile(sessionId));
};

/**
 * End-of-session teardown: request a graceful stop when a listener is alive
 * and return at once — the listener (detached) flushes its held-back model
 * request and summary fold into its own end batch, then exits. A hard kill
 * here would silently lose exactly the end-of-session data the capture
 * exists for. A dead/stale listener just gets its files cleaned up.
 */
const requestGracefulStop = (sessionId: string): void => {
  const pid = readPidFile(pidFile(sessionId));
  if (
    pid !== null &&
    isListenerAlive({ heartbeatFile: heartbeatFile(sessionId) })
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
  // but this config read — no spawn, no end event, exactly what the CLI
  // promises ("hooks stay wired but spawn nothing")
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
      ...envelope("codex", plan.sessionId, new Date().toISOString()),
      kind: "session",
      event: "end",
      ...(plan.reason ? { reason: plan.reason } : {}),
    };
    if (serverUrl && token) {
      try {
        // 2s: the SessionEnd hook budget is 3s (codex clamps it) — a hung
        // send must fail into the queue-and-sweep path, not burn the budget
        // and get killed with neither send nor queue having happened.
        await sendEvents([end], { serverUrl, token, timeoutMs: 2000 });
      } catch (e) {
        // v2 decision 21: the end event queues to disk instead of dying —
        // the hook is the ONLY sender of this event and the listener is
        // being torn down, so a sweep is spawned to ship it once the server
        // answers
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
      // stdout mode: codex injects hook stdout into the conversation as
      // context, so the NDJSON goes to stderr — visible, never spoken
      console.error(JSON.stringify(end));
    }
    requestGracefulStop(plan.sessionId);
    process.exit(0);
  }

  // spawn — but skip when a listener for this session is already alive:
  // the heartbeat is fresh. The heartbeat is the liveness proof; probing
  // the recorded PID with signal-0 instead would cost ~3s per hook fire
  // on Windows (Bun's first cross-process kill).
  mkdirSync(logDir, { recursive: true });
  const existingPid = readPidFile(pidFile(plan.sessionId));
  if (
    existingPid !== null &&
    isListenerAlive({
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
        windowsHide: true,
      }).trim();
    } catch {
      // optional
    }
  }
  if (gitRemote) childArgs.push("--git-remote", gitRemote);

  const logFile = join(logDir, `codex-${plan.sessionId}.log`);
  const pid = spawnDetachedListener({
    scriptPath: liveTs,
    args: childArgs,
    logFile,
    logDir,
  });
  writeFileSync(pidFile(plan.sessionId), String(pid));
  // make the newborn visible before its own first heartbeat lands (bun
  // start can lag seconds under AV scans) — the next hook fire would
  // otherwise read a dead liveness signal and spawn a second listener on
  // the same cursor
  writeFileSync(heartbeatFile(plan.sessionId), String(Date.now()));
  // sweep any queue files stuck since earlier outages (v2 decision 21)
  sweep();
  console.error(
    `slopwatch listener spawned: pid=${pid} log=${logFile} rollout=${plan.transcriptPath}`,
  );
  process.exit(0);
};

if (import.meta.main) {
  void main();
}
