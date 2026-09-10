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
import { runInstall } from "./install";
import { login } from "./login";
import { statusReport } from "./status";
import { runUninstall } from "./uninstall";

const HELP = `slopwatch — capture coding-agent sessions for your team's review plane

usage:
  slopwatch install [options]    detect installed agents and wire capture hooks
  slopwatch login <token>        verify and store the backend token
  slopwatch status [--dir D]     show detection, wiring, and config state
  slopwatch uninstall [--dir D]  remove slopwatch hooks

install options:
  --token <bearer>          admin-minted token (prompted on a TTY when omitted)
  --server-url <url>        backend base URL (default http://localhost:8787)
  --agent <name,...>        restrict wiring: zcode,claude-code (default: all detected)
  --dir <path>              wire project scope under this directory instead of user scope
  --summary-endpoint <url>  OpenAI-compatible endpoint for session summaries
  --summary-model <id>      model used for session summaries
  --summary-key <key>       provider key for session summaries

credentials live in ~/.slopwatch/config.json (0600) — hook commands carry
no secrets and pick the config up at fire time.`;

const args = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const list = (name: string): string[] | undefined =>
  argValue(name)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const promptToken = async (): Promise<string | undefined> => {
  if (!process.stdin.isTTY) return undefined;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(
    "paste the token minted by your Slopwatch admin: ",
  );
  rl.close();
  return answer.trim() || undefined;
};

const summaryFromArgs = ():
  | { endpoint: string; model: string; apiKey: string }
  | undefined
  | "partial" => {
  const endpoint = argValue("summary-endpoint");
  const model = argValue("summary-model");
  const apiKey = argValue("summary-key");
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
      const token = argValue("token") ?? (await promptToken());
      const result = await runInstall({
        token,
        serverUrl: argValue("server-url"),
        summary: summary || undefined,
        agents: list("agent"),
        dir: argValue("dir"),
      });
      printLines(result.lines);
      return result.ok ? 0 : 1;
    }
    case "login": {
      const positional = args[args.indexOf("login") + 1];
      const token =
        positional && !positional.startsWith("--")
          ? positional
          : (argValue("token") ?? (await promptToken()));
      if (!token) {
        console.error("usage: slopwatch login <token> [--server-url U]");
        return 1;
      }
      const result = await login({
        token,
        serverUrl: argValue("server-url"),
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
      printLines(statusReport({ dir: argValue("dir") }));
      return 0;
    }
    case "uninstall": {
      const result = runUninstall({
        agents: list("agent"),
        dir: argValue("dir"),
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
