/**
 * Detect installed agent hosts by their home directories — no process
 * spawns (slow and antivirus-patrolled on Windows). The same layout also
 * decides where install wires hooks: user scope by default, `<dir>`-scoped
 * project files with --dir.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AgentName = "zcode" | "claude-code";

export const AGENTS: readonly AgentName[] = ["zcode", "claude-code"];

export type Detection = Record<AgentName, boolean>;

export const detectAgents = (homeDir?: string): Detection => {
  const home = homeDir ?? homedir();
  return {
    zcode: existsSync(join(home, ".zcode")),
    "claude-code": existsSync(join(home, ".claude")),
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
