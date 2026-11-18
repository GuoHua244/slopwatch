/**
 * Detect installed agent hosts by their home directories — no process
 * spawns (slow and antivirus-patrolled on Windows). The same layout also
 * decides where install wires hooks: user scope by default, `<dir>`-scoped
 * project files with --dir.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AgentName = "zcode" | "claude-code" | "codebuddy" | "codex";

export const AGENTS: readonly AgentName[] = [
  "zcode",
  "claude-code",
  "codebuddy",
  "codex",
];

export type Detection = Record<AgentName, boolean>;

export const detectAgents = (homeDir?: string): Detection => {
  const home = homeDir ?? homedir();
  return {
    zcode: existsSync(join(home, ".zcode")),
    "claude-code": existsSync(join(home, ".claude")),
    codebuddy: existsSync(join(home, ".codebuddy")),
    codex: existsSync(join(home, ".codex")),
  };
};

/** User-scope ZCode hook config — fires in every project, no trust gate. */
export const zcodeUserConfigPath = (homeDir?: string): string =>
  join(homeDir ?? homedir(), ".zcode", "cli", "config.json");

/** Project-scope ZCode hook config — needs a one-time in-client trust. */
export const zcodeWorkspaceConfigPath = (dir: string): string =>
  join(dir, ".zcode", "config.json");

/** User-scope Claude Code settings. */
export const claudeUserSettingsPath = (homeDir?: string): string =>
  join(homeDir ?? homedir(), ".claude", "settings.json");

/** Project-scope Claude Code settings. */
export const claudeProjectSettingsPath = (dir: string): string =>
  join(dir, ".claude", "settings.json");

/**
 * User-scope CodeBuddy settings. Same CC-shaped `hooks` block as Claude Code
 * (research/codebuddy-capture-surfaces.md §1) — and unlike Claude Code, an
 * external edit needs no in-app review: the host's own watcher picks it up,
 * even in a session that is already running.
 */
export const codebuddyUserSettingsPath = (homeDir?: string): string =>
  join(homeDir ?? homedir(), ".codebuddy", "settings.json");

/** Project-scope CodeBuddy settings — dropped silently while the workspace
 * is untrusted, which only the client's own trust prompt can change. */
export const codebuddyProjectSettingsPath = (dir: string): string =>
  join(dir, ".codebuddy", "settings.json");

/** User-scope Codex hooks (`CODEX_HOME` relocates the whole tree, but
 * detection stays home-dir based — no process spawns). */
export const codexUserHooksPath = (homeDir?: string): string =>
  join(homeDir ?? homedir(), ".codex", "hooks.json");

/** Project-scope Codex hooks. */
export const codexProjectHooksPath = (dir: string): string =>
  join(dir, ".codex", "hooks.json");
