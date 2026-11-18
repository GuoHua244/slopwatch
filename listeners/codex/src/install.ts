/**
 * Install the slopwatch capture hooks into a Codex hooks file
 * (`~/.codex/hooks.json` user scope by default, `<dir>/.codex/hooks.json`
 * project scope with --dir). The Codex hooks system is stable and
 * default-on since ≤ 0.147.0 (measured: `codex features list` →
 * `hooks  stable  true`) and the payload shape is Claude Code-compatible
 * JSON on stdin, so one hook script serves all events. Idempotent: re-running
 * replaces our entries instead of duplicating them.
 *
 * Handlers run only after the user trusts them in the Codex TUI ("Hooks
 * need review" appears at the next session start) — the installer prints
 * that step. SessionEnd is clamped to 3s by Codex (default 1s), so our
 * SessionEnd entry pins timeout: 3; the other events get 10.
 *
 * Usage: bun install.ts [--dir <project>] [--server-url U] [--token <bearer>]
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  argvHelpers,
  atomicWriteJson,
  readSettingsJson,
} from "@slopwatch/listener-shared";

/**
 * Our hook events: SessionStart spawns the listener; UserPromptSubmit and
 * PostToolUse re-spawn it mid-turn (decision 19); Stop re-spawns at every
 * turn completion — the only keep-alive some long sessions fire; SessionEnd
 * ships session:end and requests the graceful stop.
 */
export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
  "SessionEnd",
] as const;

export type HookEntry = {
  matcher?: string;
  hooks: {
    type: "command";
    command: string;
    timeout: number;
    statusMessage?: string;
  }[];
};

/** The command line our hook script is invoked with. Codex runs the string
 * through `%COMSPEC% /C` on Windows and `$SHELL -lc` elsewhere, so the bun
 * path must be quoted when it contains spaces. `serverUrl`/`token` are
 * optional: the `slopwatch install` CLI omits them and the hook reads
 * `~/.slopwatch/config.json` at fire time (the standalone script below
 * still embeds them for a self-contained smoke setup). */
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
 * Merge our hook entries into an existing hooks object (or create the
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
    // SessionEnd matches every reason (codex fires reason "other" only).
    const entry: HookEntry = {
      matcher: "",
      hooks: [
        {
          type: "command",
          command,
          // codex clamps SessionEnd hooks to 3s — keep ours inside the clamp
          timeout: eventName === "SessionEnd" ? 3 : 10,
          statusMessage: "slopwatch capture",
        },
      ],
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

/** The hooks file for a scope. */
export const codexHooksPath = (opts: {
  dir?: string;
  homeDir?: string;
}): string =>
  opts.dir
    ? join(opts.dir, ".codex", "hooks.json")
    : join(opts.homeDir ?? homedir(), ".codex", "hooks.json");

if (import.meta.main) {
  const { arg } = argvHelpers(process.argv.slice(2));
  const dir = arg("dir");
  const serverUrl = arg("server-url") ?? "http://localhost:8787";
  const token = arg("token");

  const hookScriptPath = defaultHookScriptPath();
  const command = slopwatchHookCommand({
    bunPath: process.execPath,
    hookScriptPath,
    ...(token ? { serverUrl, token } : {}),
  });
  const hooksPath = codexHooksPath({ dir });

  const read = readSettingsJson(hooksPath);
  if (!read.ok) {
    console.error(
      `refusing to touch ${hooksPath}: it is not valid JSON. Fix or remove the file, then re-run the installer — your existing content is unchanged.`,
    );
    process.exit(1);
  }
  const merged = mergeHookConfig(read.value, command, hookScriptPath);
  atomicWriteJson(hooksPath, merged);

  console.log(`installed slopwatch hooks → ${hooksPath}`);
  console.log(JSON.stringify(merged, null, 2).replaceAll(token ?? "", "***"));
  console.log(
    "\nNEXT: start a Codex session — the TUI shows a \u201cHooks need review\u201d prompt.",
    "Trust the slopwatch hooks (untrusted hooks never fire). Sessions started",
    "before trusting run without capture until the next hook event.",
  );
}
