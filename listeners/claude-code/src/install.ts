/**
 * Install the slopwatch capture hooks into a Claude Code settings file
 * (`~/.claude/settings.json` user scope by default, `<dir>/.claude/settings.json`
 * project scope with --dir). Claude Code passes the hook payload as JSON on
 * stdin, so one hook script serves all events. Idempotent: re-running
 * replaces our entries instead of duplicating them.
 *
 * Usage: bun install.ts --token <bearer> [--dir <project>] [--server-url U]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "SessionEnd",
] as const;

export type HookEntry = {
  matcher?: string;
  hooks: { type: "command"; command: string; timeout: number }[];
};

/** The command line our hook script is invoked with. `serverUrl`/`token`
 * are optional: the `slopwatch install` CLI omits them and the hook reads
 * `~/.slopwatch/config.json` at fire time instead (the standalone script
 * below still embeds them for a self-contained smoke setup). */
export const slopwatchHookCommand = (opts: {
  bunPath: string;
  hookScriptPath: string;
  serverUrl?: string;
  token?: string;
}): string =>
  [
    JSON.stringify(opts.bunPath),
    JSON.stringify(opts.hookScriptPath),
    ...(opts.serverUrl ? ["--server-url", opts.serverUrl] : []),
    ...(opts.token ? ["--token", opts.token] : []),
  ].join(" ");

const isOurEntry = (entry: unknown, hookScriptPath: string): boolean => {
  if (typeof entry !== "object" || entry === null) return false;
  const hooks = (entry as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks)) return false;
  // the command embeds the script path quoted, so match the quoted form too
  const quoted = JSON.stringify(hookScriptPath);
  return hooks.some(
    (h) =>
      typeof h === "object" &&
      h !== null &&
      typeof (h as { command?: unknown }).command === "string" &&
      ((h as { command: string }).command.includes(hookScriptPath) ||
        (h as { command: string }).command.includes(quoted)),
  );
};

/**
 * Merge our hook entries into an existing settings object (or create the
 * hooks block). Preserves unrelated keys and hooks; replaces any previous
 * slopwatch entry in each of our events.
 */
export const mergeHookConfig = (
  existing: unknown,
  command: string,
  hookScriptPath: string,
): { hooks: Record<string, HookEntry[]> } & Record<string, unknown> => {
  const base: Record<string, unknown> =
    typeof existing === "object" && existing !== null
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const hooksBlock =
    typeof base.hooks === "object" && base.hooks !== null
      ? { ...(base.hooks as Record<string, unknown>) }
      : {};

  for (const eventName of HOOK_EVENTS) {
    const entries: HookEntry[] = Array.isArray(hooksBlock[eventName])
      ? [...(hooksBlock[eventName] as HookEntry[])]
      : [];
    // SessionStart matches every source (startup/resume/clear/compact);
    // SessionEnd matches every reason.
    const entry: HookEntry = {
      matcher: "",
      hooks: [{ type: "command", command, timeout: 10 }],
    };
    const kept = entries.filter((e) => !isOurEntry(e, hookScriptPath));
    kept.push(entry);
    hooksBlock[eventName] = kept;
  }

  base.hooks = hooksBlock;
  return base as { hooks: Record<string, HookEntry[]> } & Record<
    string,
    unknown
  >;
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dir = arg("dir");
  const serverUrl = arg("server-url") ?? "http://localhost:8787";
  const token = arg("token");
  if (!token) {
    console.error(
      "usage: bun install.ts --token <bearer> [--dir <project>] [--server-url U]",
    );
    process.exit(1);
  }

  const hookScriptPath = fileURLToPath(new URL("./hook.ts", import.meta.url));
  const command = slopwatchHookCommand({
    bunPath: process.execPath,
    hookScriptPath,
    serverUrl,
    token,
  });
  const settingsPath = dir
    ? join(dir, ".claude", "settings.json")
    : join(homedir(), ".claude", "settings.json");

  const existing = existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, "utf8"))
    : undefined;
  const merged = mergeHookConfig(existing, command, hookScriptPath);
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n");

  console.log(`installed slopwatch hooks → ${settingsPath}`);
  console.log(JSON.stringify(merged, null, 2).replaceAll(token, "***"));
  console.log(
    "\nNEXT: start a Claude Code session in any project — the first prompt spawns the capture sidecar.",
  );
}
