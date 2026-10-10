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
import {
  defaultHookScriptPath as codebuddyHookScriptPath,
  isOurEntry as isOurCodebuddyEntry,
} from "@slopwatch/listener-codebuddy/install";
import { readFileSync } from "node:fs";
import {
  AGENTS,
  claudeProjectSettingsPath,
  claudeUserSettingsPath,
  codebuddyProjectSettingsPath,
  codebuddyUserSettingsPath,
  detectAgents,
  type AgentName,
  zcodeUserConfigPath,
  zcodeWorkspaceConfigPath,
} from "./detect";

// Lenient on purpose: status only reports what it can read, so a corrupt
// file here just reads as "not wired". Contrast install.ts's readJsonIfExists,
// which deliberately THROWS on corrupt JSON so an install never clobbers a
// file it cannot parse — same shape, different contract.
const readJsonLenient = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

// Any-of detection: one surviving entry with our script means capture fires.
// Every list must cover the events its installer wires (all three wire
// PostToolUse — the mid-turn respawn of decision 19).
const CLAUDE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "SessionEnd",
];
const ZCODE_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse"];
// CodeBuddy is asked for SessionEnd too, but has never been observed to fire
// it — the listener ends itself on idle, so a surviving PostToolUse entry is
// what actually matters here.
const CODEBUDDY_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "SessionEnd",
];

const wiredClaude = (path: string): boolean => {
  const json = readJsonLenient(path) as Record<string, unknown> | undefined;
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

// CodeBuddy's settings.json is the same flat CC-shaped `hooks` block as
// Claude Code's, so its check reads the same way.
const wiredCodebuddy = (path: string): boolean => {
  const json = readJsonLenient(path) as Record<string, unknown> | undefined;
  const hooks = json?.hooks as Record<string, unknown> | undefined;
  if (!hooks) return false;
  return CODEBUDDY_EVENTS.some((event) => {
    const entries = hooks[event];
    return (
      Array.isArray(entries) &&
      entries.some((e) => isOurCodebuddyEntry(e, codebuddyHookScriptPath()))
    );
  });
};

const wiredZcode = (path: string): boolean => {
  const json = readJsonLenient(path) as Record<string, unknown> | undefined;
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
  if (config.disabled) parts.push("CAPTURE PAUSED (`slopwatch resume`)");
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
    const wiredAt = (agent: AgentName, scope: "user" | "project"): boolean => {
      const path =
        agent === "zcode"
          ? scope === "user"
            ? zcodeUserConfigPath(home)
            : zcodeWorkspaceConfigPath(opts.dir!)
          : agent === "codebuddy"
            ? scope === "user"
              ? codebuddyUserSettingsPath(home)
              : codebuddyProjectSettingsPath(opts.dir!)
            : scope === "user"
              ? claudeUserSettingsPath(home)
              : claudeProjectSettingsPath(opts.dir!);
      return agent === "zcode"
        ? wiredZcode(path)
        : agent === "codebuddy"
          ? wiredCodebuddy(path)
          : wiredClaude(path);
    };
    lines.push(
      `${agent}: detected · user-scope hooks ${wiredAt(agent, "user") ? "wired" : "not wired"}`,
    );
    if (opts.dir) {
      lines.push(
        `${agent}: project scope (${opts.dir}) hooks ${wiredAt(agent, "project") ? "wired" : "not wired"}`,
      );
    }
  }
  return lines;
};
