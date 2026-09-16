/**
 * Install the slopwatch capture hooks into a Claude Code settings file
 * (`~/.claude/settings.json` user scope by default, `<dir>/.claude/settings.json`
 * project scope with --dir). Claude Code passes the hook payload as JSON on
 * stdin, so one hook script serves all events. Idempotent: re-running
 * replaces our entries instead of duplicating them.
 *
 * Usage: bun install.ts --token <bearer> [--dir <project>] [--server-url U]
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  argvHelpers,
  atomicWriteJson,
  readSettingsJson,
} from "@slopwatch/listener-shared";

export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
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

/** Does this hooks entry point at our hook script? */
export const isOurEntry = (entry: unknown, hookScriptPath: string): boolean => {
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

/** Absolute path of the hook script the installed command points at. */
export const defaultHookScriptPath = (): string =>
  fileURLToPath(new URL("./hook.ts", import.meta.url));

/**
 * Remove our entries from each of our hook events. Event keys that empty
 * out are deleted; unrelated keys and hooks are preserved. Returns the
 * input unchanged (as a copy) when nothing of ours exists.
 */
export const removeHookConfig = (
  existing: unknown,
  hookScriptPath: string,
): Record<string, unknown> => {
  const base: Record<string, unknown> =
    typeof existing === "object" && existing !== null
      ? { ...(existing as Record<string, unknown>) }
      : {};
  if (typeof base.hooks !== "object" || base.hooks === null) return base;
  const hooksBlock = { ...(base.hooks as Record<string, unknown>) };
  for (const eventName of HOOK_EVENTS) {
    if (!Array.isArray(hooksBlock[eventName])) continue;
    const kept = (hooksBlock[eventName] as unknown[]).filter(
      (e) => !isOurEntry(e, hookScriptPath),
    );
    if (kept.length === 0) delete hooksBlock[eventName];
    else hooksBlock[eventName] = kept;
  }
  base.hooks = hooksBlock;
  return base;
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
  const { arg } = argvHelpers(process.argv.slice(2));
  const dir = arg("dir");
  const serverUrl = arg("server-url") ?? "http://localhost:8787";
  const token = arg("token");
  if (!token) {
    console.error(
      "usage: bun install.ts --token <bearer> [--dir <project>] [--server-url U]",
    );
    process.exit(1);
  }

  const hookScriptPath = defaultHookScriptPath();
  const command = slopwatchHookCommand({
    bunPath: process.execPath,
    hookScriptPath,
    serverUrl,
    token,
  });
  const settingsPath = dir
    ? join(dir, ".claude", "settings.json")
    : join(homedir(), ".claude", "settings.json");

  const read = readSettingsJson(settingsPath);
  if (!read.ok) {
    console.error(
      `refusing to touch ${settingsPath}: it is not valid JSON. Fix or remove the file, then re-run the installer — your existing content is unchanged.`,
    );
    process.exit(1);
  }
  const merged = mergeHookConfig(read.value, command, hookScriptPath);
  // Temp+rename (inside the helper) so a crash mid-write cannot truncate the
  // user's settings; 0o600 because the standalone install embeds the token.
  atomicWriteJson(settingsPath, merged, 0o600);

  console.log(`installed slopwatch hooks → ${settingsPath}`);
  console.log(JSON.stringify(merged, null, 2).replaceAll(token, "***"));
  console.log(
    "\nNEXT: start a Claude Code session in any project — the first prompt spawns the capture listener.",
  );
}
