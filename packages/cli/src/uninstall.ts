/**
 * `slopwatch uninstall`: remove our hook entries, leaving unrelated
 * configuration untouched. Scoping mirrors install: --dir strips ONLY that
 * project's files; without --dir ONLY the user-scope files are stripped.
 * The stored credentials are kept — deleting ~/.slopwatch/config.json is
 * an explicit, separate decision.
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
import {
  defaultHookScriptPath as codebuddyHookScriptPath,
  removeHookConfig as removeCodebuddyHooks,
} from "@slopwatch/listener-codebuddy/install";
import {
  defaultHookScriptPath as codexHookScriptPath,
  removeHookConfig as removeCodexHooks,
} from "@slopwatch/listener-codex/install";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  AGENTS,
  claudeProjectSettingsPath,
  claudeUserSettingsPath,
  codebuddyProjectSettingsPath,
  codebuddyUserSettingsPath,
  codexProjectHooksPath,
  codexUserHooksPath,
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
  // mirror install's scoping: --dir means ONLY that project's files, no
  // --dir means ONLY the user-scope files — never both in one run
  if (wanted.includes("zcode")) {
    const targets = opts.dir
      ? [zcodeWorkspaceConfigPath(opts.dir)]
      : [zcodeUserConfigPath(home)];
    if (!detected.zcode && !targets.some((t) => existsSync(t))) {
      lines.push("zcode: not detected — nothing to remove");
    }
    for (const target of targets) {
      const result = stripHooks(target, removeZcodeHooks, defaultSpawnerPath());
      if (result) lines.push(`zcode: ${result}`);
    }
  }

  if (wanted.includes("claude-code")) {
    const targets = opts.dir
      ? [claudeProjectSettingsPath(opts.dir)]
      : [claudeUserSettingsPath(home)];
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

  if (wanted.includes("codebuddy")) {
    const targets = opts.dir
      ? [codebuddyProjectSettingsPath(opts.dir)]
      : [codebuddyUserSettingsPath(home)];
    if (!detected.codebuddy && !targets.some((t) => existsSync(t))) {
      lines.push("codebuddy: not detected — nothing to remove");
    }
    for (const target of targets) {
      const result = stripHooks(
        target,
        removeCodebuddyHooks,
        codebuddyHookScriptPath(),
      );
      if (result) lines.push(`codebuddy: ${result}`);
    }
  }

  if (wanted.includes("codex")) {
    const targets = opts.dir
      ? [codexProjectHooksPath(opts.dir)]
      : [codexUserHooksPath(home)];
    if (!detected.codex && !targets.some((t) => existsSync(t))) {
      lines.push("codex: not detected — nothing to remove");
    }
    for (const target of targets) {
      const result = stripHooks(
        target,
        removeCodexHooks,
        codexHookScriptPath(),
      );
      if (result) lines.push(`codex: ${result}`);
    }
  }

  lines.push(
    `credentials kept at ${configFilePath(home)} — delete the file to forget them`,
  );
  return { ok: true, lines };
};
