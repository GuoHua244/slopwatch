/**
 * `slopwatch install` orchestration: verify credentials into the central
 * config (delegating to the login flow), detect installed agent hosts, and
 * wire each one's hooks by reusing the listener packages' merge functions —
 * the hooks themselves carry no credentials; they read
 * ~/.slopwatch/config.json at fire time. Everything is idempotent:
 * re-running replaces our entries and refreshes the stored config.
 */
import { configFilePath, loadConfig, saveConfig } from "@slopwatch/config";
import {
  defaultHookScriptPath,
  mergeHookConfig as mergeClaudeHooks,
  slopwatchHookCommand,
} from "@slopwatch/listener-claude-code/install";
import {
  defaultSpawnerPath,
  mergeHookConfig as mergeZcodeHooks,
  slopwatchHookEntry,
} from "@slopwatch/listener-zcode/install";
import {
  defaultHookScriptPath as codebuddyHookScriptPath,
  mergeHookConfig as mergeCodebuddyHooks,
  slopwatchHookCommand as codebuddyHookCommand,
} from "@slopwatch/listener-codebuddy/install";
import {
  defaultHookScriptPath as codexHookScriptPath,
  mergeHookConfig as mergeCodexHooks,
} from "@slopwatch/listener-codex/install";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
import { login } from "./login";

export type InstallOptions = {
  /** Admin-minted bearer token; verified and stored before any wiring. */
  token?: string;
  serverUrl?: string;
  /** Subset of AGENTS to wire; default: every detected agent. */
  agents?: string[];
  /** Wire project scope under this directory instead of user scope. */
  dir?: string;
  homeDir?: string;
  fetchImpl?: typeof fetch;
};

export type InstallResult = { ok: boolean; lines: string[] };

const readJsonIfExists = (path: string): unknown => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${path} is not valid JSON — fix or remove it first, then re-run`,
    );
  }
};

const writeJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
};

export const runInstall = async (
  opts: InstallOptions,
): Promise<InstallResult> => {
  const lines: string[] = [];
  const home = opts.homeDir;
  const existing = loadConfig(home);

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

  // 1. credentials — a supplied token is verified and stored first
  let config = existing;
  if (opts.token) {
    const verdict = await login({
      token: opts.token,
      serverUrl: opts.serverUrl,
      homeDir: home,
      fetchImpl: opts.fetchImpl,
    });
    if (!verdict.ok) return { ok: false, lines: [verdict.error] };
    lines.push(
      `token verified (${verdict.user}${verdict.isDri ? ", DRI" : ""})`,
    );
    config = loadConfig(home);
    if (!config) {
      return {
        ok: false,
        lines: ["internal: credentials missing after login"],
      };
    }
  } else if (!existing) {
    return {
      ok: false,
      lines: [
        "no credentials found — pass --token <bearer> (or run on a terminal to be prompted).",
        "tokens are minted by your Slopwatch admin in the admin UI.",
      ],
    };
  }
  config = config!;
  let dirty = false;
  if (opts.serverUrl && !opts.token) {
    // with a token, login already stored the server URL
    config = { ...config, serverUrl: opts.serverUrl };
    dirty = true;
  }
  if (dirty) {
    saveConfig(config, home);
    lines.push(`config written → ${configFilePath(home)}`);
  }

  // 2. detect and wire each host
  try {
    wireHosts(opts, lines);
  } catch (e) {
    return {
      ok: false,
      lines: [...lines, e instanceof Error ? e.message : String(e)],
    };
  }

  return { ok: true, lines };
};

const wireHosts = (opts: InstallOptions, lines: string[]): void => {
  const home = opts.homeDir;
  const detected = detectAgents(home);
  const wanted: AgentName[] = (
    (opts.agents as AgentName[] | undefined) ?? AGENTS
  ).filter((a, i, all) => all.indexOf(a) === i);
  const bunPath = process.execPath;
  const scope = opts.dir ? "project scope" : "user scope";

  if (wanted.includes("zcode")) {
    if (!detected.zcode) {
      lines.push("zcode: not detected — skipped");
    } else {
      const entry = slopwatchHookEntry({
        bunPath,
        spawnerPath: defaultSpawnerPath(),
      });
      const configPath = opts.dir
        ? zcodeWorkspaceConfigPath(opts.dir)
        : zcodeUserConfigPath(home);
      const merged = mergeZcodeHooks(readJsonIfExists(configPath), entry);
      writeJson(configPath, merged);
      lines.push(`zcode: hooks wired → ${configPath} (${scope})`);
      // mergeHookConfig only forces hooks.enabled on when the key is absent;
      // an explicit false stays and must be surfaced to the user
      if (merged.hooks.enabled === false) {
        lines.push(
          "zcode: WARNING — hooks.enabled is false in this config; slopwatch hooks will not fire until it is set to true",
        );
      }
      if (opts.dir) {
        lines.push(
          "zcode: approve the workspace-hook TRUST prompt in the client — sessions started before that fire nothing",
        );
      } else {
        lines.push(
          "zcode: user-level hooks fire in every project; restart running ZCode instances to pick them up",
        );
      }
    }
  }

  if (wanted.includes("claude-code")) {
    if (!detected["claude-code"]) {
      lines.push("claude-code: not detected — skipped");
    } else {
      const hookScriptPath = defaultHookScriptPath();
      const command = slopwatchHookCommand({ bunPath, hookScriptPath });
      const settingsPath = opts.dir
        ? claudeProjectSettingsPath(opts.dir)
        : claudeUserSettingsPath(home);
      const merged = mergeClaudeHooks(
        readJsonIfExists(settingsPath),
        command,
        hookScriptPath,
      );
      writeJson(settingsPath, merged);
      lines.push(`claude-code: hooks wired → ${settingsPath} (${scope})`);
    }
  }

  if (wanted.includes("codebuddy")) {
    if (!detected.codebuddy) {
      lines.push("codebuddy: not detected — skipped");
    } else {
      const hookScriptPath = codebuddyHookScriptPath();
      const command = codebuddyHookCommand({ bunPath, hookScriptPath });
      const settingsPath = opts.dir
        ? codebuddyProjectSettingsPath(opts.dir)
        : codebuddyUserSettingsPath(home);
      const merged = mergeCodebuddyHooks(
        readJsonIfExists(settingsPath),
        command,
        hookScriptPath,
      );
      writeJson(settingsPath, merged);
      lines.push(`codebuddy: hooks wired → ${settingsPath} (${scope})`);
      // no in-app review step exists for this host (measured: an external
      // edit is picked up by the client's own watcher within ~30s, and at
      // once in a newly opened session) — but project scope still needs the
      // workspace to be trusted, or the entries are dropped silently
      if (opts.dir) {
        lines.push(
          "codebuddy: approve the workspace TRUST prompt in the client — project hooks fire for nothing in an untrusted workspace",
        );
      }
    }
  }

  if (wanted.includes("codex")) {
    if (!detected.codex) {
      lines.push("codex: not detected — skipped");
    } else {
      const hookScriptPath = codexHookScriptPath();
      const command = [
        JSON.stringify(bunPath),
        JSON.stringify(hookScriptPath),
      ].join(" ");
      const hooksPath = opts.dir
        ? codexProjectHooksPath(opts.dir)
        : codexUserHooksPath(home);
      const merged = mergeCodexHooks(
        readJsonIfExists(hooksPath),
        command,
        hookScriptPath,
      );
      writeJson(hooksPath, merged);
      lines.push(`codex: hooks wired → ${hooksPath} (${scope})`);
      // the hooks engine is stable and default-on since ≤ 0.147.0 (measured
      // `codex features list`), but handlers run only after the user trusts
      // them — the review modal appears at the next TUI session start
      lines.push(
        "codex: trust the slopwatch hooks at the next session start (TUI \u201cHooks need review\u201d prompt) — untrusted hooks never fire",
      );
    }
  }
};
