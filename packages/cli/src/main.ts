#!/usr/bin/env bun
/**
 * slopwatch CLI. Thin dispatch over the injectable cores — all real logic
 * lives in modules with tests; this file owns argv parsing, the interactive
 * token prompt, and exit codes.
 *
 *   slopwatch install   detect installed agents and wire capture hooks
 *   slopwatch login     verify and store the backend token
 *   slopwatch status    show detection, wiring, and config state
 *   slopwatch uninstall remove slopwatch hooks
 */
import { argvHelpers } from "@slopwatch/listener-shared";
import { runInstall } from "./install";
import { login } from "./login";
import { setCapturePaused } from "./pause";
import { statusReport } from "./status";
import { runUninstall } from "./uninstall";

const HELP = `slopwatch — capture coding-agent sessions for your team's review plane

usage:
  slopwatch install [options]    detect installed agents and wire capture hooks
  slopwatch login [token]        verify and store the backend token (prompted,
                                 input hidden, when the token is omitted)
  slopwatch status [--dir D]     show detection, wiring, and config state
  slopwatch pause                stop capturing (hooks stay wired, nothing spawns)
  slopwatch resume               turn capture back on after a pause
  slopwatch uninstall [--dir D]  remove slopwatch hooks (user scope, or
                                 only that project's scope with --dir)

install options:
  --token <bearer>          admin-minted token (prompted on a TTY when omitted)
  --server-url <url>        backend base URL (default http://localhost:8787)
  --agent <name,...>        restrict wiring: zcode,claude-code (default: all detected)
  --dir <path>              wire project scope under this directory instead of user scope
  --summary-endpoint <url>  OpenAI-compatible endpoint for session summaries
  --summary-model <id>      model used for session summaries
  --summary-key <key>       provider key for session summaries

flags accept "--flag value" or "--flag=value". credentials live in
~/.slopwatch/config.json (0600) — hook commands carry no secrets and pick
the config up at fire time.`;

const args = process.argv.slice(2);
const { arg } = argvHelpers(args);
const list = (name: string): string[] | undefined =>
  arg(name)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const PROMPT = "paste the token minted by your Slopwatch admin: ";

/**
 * Read a token from the terminal WITHOUT echoing it: raw mode, char by char
 * (Enter submits, backspace deletes, Ctrl-C aborts with exit code 1). The
 * terminal is always restored before the promise settles.
 */
const promptTokenHidden = (): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    if (typeof stdin.setRawMode !== "function") {
      reject(new Error("stdin has no raw mode"));
      return;
    }
    process.stderr.write(PROMPT);
    let token = "";
    let settled = false;
    const restore = (): void => {
      stdin.removeListener("data", onData);
      stdin.removeListener("error", onError);
      try {
        stdin.setRawMode(false);
      } catch {
        // best effort — the fallback prompt still works either way
      }
      try {
        stdin.pause();
      } catch {
        // best effort
      }
    };
    const settle = (value: string): void => {
      if (settled) return;
      settled = true;
      restore();
      resolve(value);
    };
    const fail = (e: unknown): void => {
      if (settled) return;
      settled = true;
      restore();
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          process.stderr.write("\n");
          settle(token.trim());
          return;
        }
        if (ch === "\u0003") {
          // Ctrl-C: restore the terminal before dying so the shell is
          // not left in raw mode
          restore();
          process.stderr.write("\n");
          process.exit(1);
        }
        if (ch === "\u007f" || ch === "\b") {
          token = token.slice(0, -1);
          continue;
        }
        token += ch;
      }
    };
    const onError = (e: unknown): void => fail(e);
    try {
      stdin.setRawMode(true);
    } catch (e) {
      fail(e);
      return;
    }
    stdin.on("data", onData);
    stdin.on("error", onError);
  });

const promptToken = async (): Promise<string | undefined> => {
  if (!process.stdin.isTTY) return undefined;
  try {
    const token = await promptTokenHidden();
    return token || undefined;
  } catch {
    // raw mode unavailable or failed — fall back to the echoing readline
    // prompt; a visible token beats a broken login
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    const answer = await rl.question(PROMPT);
    rl.close();
    return answer.trim() || undefined;
  }
};

const summaryFromArgs = ():
  | { endpoint: string; model: string; apiKey: string }
  | undefined
  | "partial" => {
  const endpoint = arg("summary-endpoint");
  const model = arg("summary-model");
  const apiKey = arg("summary-key");
  if (!endpoint && !model && !apiKey) return undefined;
  if (!endpoint || !model || !apiKey) return "partial";
  return { endpoint, model, apiKey };
};

const printLines = (lines: string[]): void => {
  for (const line of lines) console.log(line);
};

const main = async (): Promise<number> => {
  const [command] = args;
  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    console.log(HELP);
    return 0;
  }

  switch (command) {
    case "install": {
      const summary = summaryFromArgs();
      if (summary === "partial") {
        console.error(
          "install: --summary-endpoint, --summary-model and --summary-key go together",
        );
        return 1;
      }
      const token = arg("token") ?? (await promptToken());
      const result = await runInstall({
        token,
        serverUrl: arg("server-url"),
        summary: summary || undefined,
        agents: list("agent"),
        dir: arg("dir"),
      });
      printLines(result.lines);
      return result.ok ? 0 : 1;
    }
    case "login": {
      const positional = args[args.indexOf("login") + 1];
      const argvToken =
        positional && !positional.startsWith("--") ? positional : arg("token");
      if (argvToken) {
        console.error(
          "note: the token was passed on the command line — it can land in your shell history; prefer the prompted form (`slopwatch login`).",
        );
      }
      const token = argvToken ?? (await promptToken());
      if (!token) {
        console.error("usage: slopwatch login <token> [--server-url U]");
        return 1;
      }
      const result = await login({
        token,
        serverUrl: arg("server-url"),
      });
      if (!result.ok) {
        console.error(`login failed: ${result.error}`);
        return 1;
      }
      console.log(
        `logged in as ${result.user} → ${result.serverUrl} (stored in ~/.slopwatch/config.json)`,
      );
      return 0;
    }
    case "status": {
      printLines(statusReport({ dir: arg("dir") }));
      return 0;
    }
    case "pause":
    case "resume": {
      const result = setCapturePaused(command === "pause");
      printLines(result.lines);
      return result.ok ? 0 : 1;
    }
    case "uninstall": {
      const result = runUninstall({
        agents: list("agent"),
        dir: arg("dir"),
      });
      printLines(result.lines);
      return result.ok ? 0 : 1;
    }
    default:
      console.error(`unknown command "${command}" — try: slopwatch help`);
      return 1;
  }
};

process.exitCode = await main();
