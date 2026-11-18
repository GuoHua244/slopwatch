/**
 * Install the slopwatch capture hooks into a CodeBuddy settings file
 * (`~/.codebuddy/settings.json` user scope by default, `<dir>/.codebuddy/settings.json`
 * project scope with --dir). CodeBuddy passes the hook payload as JSON on
 * stdin, so one hook script serves all events. Idempotent: re-running
 * replaces our entries instead of duplicating them.
 *
 * Two host facts shape these instructions (research/codebuddy-capture-surfaces.md §1):
 * - **No review step is needed.** An external edit is picked up by the host's
 *   own file watcher inside ~30 s, even mid-session — but project-scope
 *   installs additionally need the workspace to be **trusted**, or the hooks
 *   are dropped silently.
 * - Only `PostToolUse` fires reliably; `Stop`/`SessionEnd` were never
 *   observed, so the listener is the one that decides the session ended.
 *
 * Usage: bun install.ts --token <bearer> [--dir <project>] [--server-url U]
 */
import { homedir } from "node:os";
import { join as joinWin32 } from "node:path/win32";
import { fileURLToPath } from "node:url";
import {
  argvHelpers,
  atomicWriteJson,
  readSettingsJson,
} from "@slopwatch/listener-shared";

/**
 * SessionStart starts it, UserPromptSubmit restarts it after an idle exit,
 * PostToolUse keeps it alive inside a long tool loop (decision 19's fix), and
 * SessionEnd is registered for the builds that some day fire it — the
 * measured build never did, which is why the listener also exits on idle.
 */
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
 * `~/.slopwatch/config.json` at fire time instead. */
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

/** User-scope settings file. */
export const codebuddyUserSettingsPath = (homeDir?: string): string =>
  // The settings file lives in Windows-shaped CodeBuddy dirs, so the join
  // uses win32 semantics on every host (tests run on Linux too).
  joinWin32(homeDir ?? homedir(), ".codebuddy", "settings.json");

/** Project-scope settings file — only honoured in a trusted workspace. */
export const codebuddyProjectSettingsPath = (dir: string): string =>
  joinWin32(dir, ".codebuddy", "settings.json");

/** Remove our entries from each of our hook events; keep everything else. */
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
 * hooks block). Unrelated keys and unrelated hooks are preserved verbatim —
 * the user's own hooks keep firing next to ours.
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
    // empty matcher: every source every tool — the hook script decides
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
    ? codebuddyProjectSettingsPath(dir)
    : codebuddyUserSettingsPath();

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
    [
      "",
      "NEXT:",
      dir
        ? "  1. Open this project in CodeBuddy and GRANT WORKSPACE TRUST — project-scope hooks are dropped silently while the workspace is untrusted."
        : "  1. Nothing else to run — no in-app review step exists.",
      "  2. Start a session (or keep the current one talking): the host's own",
      "     file watcher picks the hooks up within ~30s, and immediately in a",
      "     newly opened session.",
      "  3. Capture runs while the session is live and ends itself after 5 idle",
      "     minutes — this agent has no working SessionEnd hook.",
    ].join("\n"),
  );
}
