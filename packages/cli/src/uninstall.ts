/**
 * `slopwatch uninstall`: remove our hook entries from every scope, leaving
 * unrelated configuration untouched. The stored credentials are kept —
 * deleting ~/.slopwatch/config.json is an explicit, separate decision.
 */
import { configFilePath } from "@slopwatch/config";
import {
  defaultHookScriptPath,
  removeHookConfig as removeClaudeHooks,
} from "@slopwatch/listener-claude-code/install";
import {
  defaultSpawnerPath,
  removeHookConfig as removeZcodeHooks,
} from "@slopwatch/listener-zcode/install";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  AGENTS,
  claudeProjectSettingsPath,
  claudeUserSettingsPath,
  detectAgents,
  type AgentName,
  zcodeUserConfigPath,
  zcodeWorkspaceConfigPath,
} from "./detect";

export type UninstallOptions = {
  agents?: string[];
  dir?: string;
  homeDir?: string;
};

export type UninstallResult = { ok: boolean; lines: string[] };

const stripHooks = (
  path: string,
  remove: (existing: unknown, ours: string) => Record<string, unknown>,
  ours: string,
): string | null => {
  if (!existsSync(path)) return null;
  let existing: unknown;
  try {
    existing = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return `${path} is not valid JSON — left untouched`;
  }
  const cleaned = remove(existing, ours);
  if (JSON.stringify(cleaned) === JSON.stringify(existing)) return null;
  writeFileSync(path, JSON.stringify(cleaned, null, 2) + "\n");
  return `removed → ${path}`;
};

export const runUninstall = (opts: UninstallOptions): UninstallResult => {
  const lines: string[] = [];
  const home = opts.homeDir;

  for (const agent of opts.agents ?? []) {
    if (!AGENTS.includes(agent as AgentName)) {
      return {
        ok: false,
        lines: [
          `unknown agent "${agent}" — known agents: ${AGENTS.join(", ")}`,
        ],
      };
    }
  }

  const wanted: AgentName[] = (
    (opts.agents as AgentName[] | undefined) ?? AGENTS
  ).filter((a, i, all) => all.indexOf(a) === i);
  const detected = detectAgents(home);

  if (wanted.includes("zcode")) {
    const targets = [
      zcodeUserConfigPath(home),
      ...(opts.dir ? [zcodeWorkspaceConfigPath(opts.dir)] : []),
    ];
    if (!detected.zcode && !targets.some((t) => existsSync(t))) {
      lines.push("zcode: not detected — nothing to remove");
    }
    for (const target of targets) {
      const result = stripHooks(target, removeZcodeHooks, defaultSpawnerPath());
      if (result) lines.push(`zcode: ${result}`);
    }
  }

  if (wanted.includes("claude-code")) {
    const targets = [
      claudeUserSettingsPath(home),
      ...(opts.dir ? [claudeProjectSettingsPath(opts.dir)] : []),
    ];
    if (!detected["claude-code"] && !targets.some((t) => existsSync(t))) {
      lines.push("claude-code: not detected — nothing to remove");
    }
    for (const target of targets) {
      const result = stripHooks(
        target,
        removeClaudeHooks,
        defaultHookScriptPath(),
      );
      if (result) lines.push(`claude-code: ${result}`);
    }
  }

  lines.push(
    `credentials kept at ${configFilePath(home)} — delete the file to forget them`,
  );
  return { ok: true, lines };
};
