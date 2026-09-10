/**
 * `slopwatch status`: what is installed, what is wired, and what the
 * stored config says — credentials redacted.
 */
import {
  configFilePath,
  loadConfig,
  redactConfig,
  type SlopwatchConfig,
} from "@slopwatch/config";
import {
  defaultHookScriptPath,
  isOurEntry,
} from "@slopwatch/listener-claude-code/install";
import {
  defaultSpawnerPath,
  isOurMatcherEntry,
} from "@slopwatch/listener-zcode/install";
import { readFileSync } from "node:fs";
import {
  AGENTS,
  claudeProjectSettingsPath,
  claudeUserSettingsPath,
  detectAgents,
  zcodeUserConfigPath,
  zcodeWorkspaceConfigPath,
} from "./detect";

const readJsonIfExists = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

const CLAUDE_EVENTS = ["SessionStart", "UserPromptSubmit", "SessionEnd"];
const ZCODE_EVENTS = ["SessionStart", "UserPromptSubmit"];

const wiredClaude = (path: string): boolean => {
  const json = readJsonIfExists(path) as Record<string, unknown> | undefined;
  const hooks = json?.hooks as Record<string, unknown> | undefined;
  if (!hooks) return false;
  return CLAUDE_EVENTS.some((event) => {
    const entries = hooks[event];
    return (
      Array.isArray(entries) &&
      entries.some((e) => isOurEntry(e, defaultHookScriptPath()))
    );
  });
};

const wiredZcode = (path: string): boolean => {
  const json = readJsonIfExists(path) as Record<string, unknown> | undefined;
  const events = (json?.hooks as Record<string, unknown> | undefined)
    ?.events as Record<string, unknown> | undefined;
  if (!events) return false;
  return ZCODE_EVENTS.some((event) => {
    const entries = events[event];
    return (
      Array.isArray(entries) &&
      entries.some((e) => isOurMatcherEntry(e, defaultSpawnerPath()))
    );
  });
};

const describeConfig = (config: SlopwatchConfig | null): string => {
  if (!config) return "none";
  const parts = [
    `server ${config.serverUrl}`,
    `token ${redactConfig(config).token}`,
  ];
  parts.push(
    config.summary
      ? `summary ${config.summary.model} @ ${config.summary.endpoint}`
      : "no llm summary",
  );
  return parts.join(" · ");
};

export const statusReport = (opts: {
  homeDir?: string;
  dir?: string;
}): string[] => {
  const lines: string[] = [];
  const home = opts.homeDir;
  const config = loadConfig(home);
  lines.push(
    `credentials: ${describeConfig(config)}  (${configFilePath(home)})`,
  );

  const detected = detectAgents(home);
  for (const agent of AGENTS) {
    if (!detected[agent]) {
      lines.push(`${agent}: not detected`);
      continue;
    }
    const userWired =
      agent === "zcode"
        ? wiredZcode(zcodeUserConfigPath(home))
        : wiredClaude(claudeUserSettingsPath(home));
    lines.push(
      `${agent}: detected · user-scope hooks ${userWired ? "wired" : "not wired"}`,
    );
    if (opts.dir) {
      const projectWired =
        agent === "zcode"
          ? wiredZcode(zcodeWorkspaceConfigPath(opts.dir))
          : wiredClaude(claudeProjectSettingsPath(opts.dir));
      lines.push(
        `${agent}: project scope (${opts.dir}) hooks ${projectWired ? "wired" : "not wired"}`,
      );
    }
  }
  return lines;
};
