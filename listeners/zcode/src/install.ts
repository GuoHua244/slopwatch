/**
 * Install the slopwatch capture hook into a project's ZCode workspace config
 * (`<dir>/.zcode/config.json`). ZCode expands ${ZCODE_SESSION_ID} in hook args
 * at fire time, so the spawner receives the real session id. Idempotent:
 * re-running replaces our entry instead of duplicating it. The config file
 * contains the bearer token — keep `<dir>/.zcode/` out of version control.
 *
 * Usage: bun install.ts --token <bearer> [--dir <project>] [--server-url U]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type HookProcess = {
  type: "process";
  command: string;
  args: string[];
  timeoutMs: number;
  statusMessage: string;
};

export const slopwatchHookEntry = (opts: {
  bunPath: string;
  spawnerPath: string;
  serverUrl: string;
  token: string;
}): HookProcess => ({
  type: "process",
  command: opts.bunPath,
  args: [
    opts.spawnerPath,
    "--session-id",
    "${ZCODE_SESSION_ID}",
    "--server-url",
    opts.serverUrl,
    "--token",
    opts.token,
  ],
  timeoutMs: 15000,
  statusMessage: "slopwatch capture",
});

type MatcherEntry = { matcher?: string; hooks: unknown[] };

const isOurMatcherEntry = (entry: unknown, spawnerPath: string): boolean => {
  if (typeof entry !== "object" || entry === null) return false;
  const hooks = (entry as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (h) =>
      typeof h === "object" &&
      h !== null &&
      Array.isArray((h as { args?: unknown }).args) &&
      (h as { args: unknown[] }).args[0] === spawnerPath,
  );
};

/**
 * Our hook events: SessionStart spawns the sidecar; UserPromptSubmit re-spawns
 * it if an idle timeout killed it mid-session (messages in an already-open
 * session fire no SessionStart — the spawner's liveness check makes this a
 * cheap no-op when the sidecar is alive).
 */
export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit"] as const;

/**
 * Merge our hooks into an existing workspace config (or create one).
 * Preserves unrelated keys and hooks; replaces any previous slopwatch entry
 * in each of our events. Config-file hooks must set `hooks.enabled: true`.
 */
export const mergeHookConfig = (
  existing: unknown,
  entry: HookProcess,
): Record<string, unknown> & {
  hooks: { enabled: boolean; events: Record<string, MatcherEntry[]> };
} => {
  const base: Record<string, unknown> =
    typeof existing === "object" && existing !== null
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const hooks = (
    typeof base.hooks === "object" && base.hooks !== null
      ? { ...(base.hooks as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  const events = (
    typeof hooks.events === "object" && hooks.events !== null
      ? { ...(hooks.events as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;

  for (const eventName of HOOK_EVENTS) {
    const existingEntries = Array.isArray(events[eventName])
      ? [...(events[eventName] as unknown[])]
      : [];
    const kept = existingEntries.filter(
      (e) => !isOurMatcherEntry(e, entry.args[0]!),
    );
    kept.push({ hooks: [entry] });
    events[eventName] = kept;
  }

  hooks.events = events;
  hooks.enabled = true;
  base.hooks = hooks;
  return base as Record<string, unknown> & {
    hooks: { enabled: boolean; events: Record<string, MatcherEntry[]> };
  };
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dir = arg("dir") ?? process.cwd();
  const serverUrl = arg("server-url") ?? "http://localhost:8787";
  const token = arg("token");
  if (!token) {
    console.error(
      "usage: bun install.ts --token <bearer> [--dir <project>] [--server-url U]",
    );
    process.exit(1);
  }

  const spawnerPath = fileURLToPath(new URL("./spawner.ts", import.meta.url));
  const entry = slopwatchHookEntry({
    bunPath: process.execPath,
    spawnerPath,
    serverUrl,
    token,
  });
  const configPath = join(dir, ".zcode", "config.json");

  const existing = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8"))
    : undefined;
  const merged = mergeHookConfig(existing, entry);
  mkdirSync(join(dir, ".zcode"), { recursive: true });
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n");

  console.log(`installed slopwatch hook → ${configPath}`);
  console.log(JSON.stringify(merged, null, 2).replaceAll(token, "***"));
  console.log(
    "\nNEXT: start a session in this project — ZCode will ask you to TRUST the workspace hooks.\nApprove it (sessions started before trust is granted fire nothing). Keep the server running.",
  );
}
