import { describe, expect, test } from "bun:test";
import {
  defaultHookScriptPath,
  HOOK_EVENTS,
  mergeHookConfig,
  removeHookConfig,
  slopwatchHookCommand,
} from "./install";

const bunPath = "C:\\bun\\bun.exe";
const hookScript = "D:\\repo\\listeners\\claude-code\\src\\hook.ts";
const command = slopwatchHookCommand({
  bunPath,
  hookScriptPath: hookScript,
  serverUrl: "http://localhost:8787",
  token: "tok-1",
});

describe("slopwatchHookCommand", () => {
  test("invokes bun with the hook script and carries the token", () => {
    // paths are embedded quoted so spaces survive the hook shell
    expect(command).toContain(JSON.stringify(bunPath));
    expect(command).toContain(JSON.stringify(hookScript));
    expect(command).toContain("--server-url http://localhost:8787");
    expect(command).toContain("tok-1");
  });

  test("omits --server-url/--token when not given (central-config mode)", () => {
    const bare = slopwatchHookCommand({ bunPath, hookScriptPath: hookScript });
    expect(bare).toContain(JSON.stringify(hookScript));
    expect(bare).not.toContain("--server-url");
    expect(bare).not.toContain("--token");
  });

  test("a credential-free command replaces a legacy embedded-token entry", () => {
    const bare = slopwatchHookCommand({ bunPath, hookScriptPath: hookScript });
    const merged = mergeHookConfig(
      mergeHookConfig(undefined, command, hookScript),
      bare,
      hookScript,
    );
    for (const name of HOOK_EVENTS) {
      expect(merged.hooks[name]).toHaveLength(1);
      expect(merged.hooks[name]![0]!.hooks[0]!.command).toBe(bare);
    }
  });
});

describe("mergeHookConfig", () => {
  test("creates the hooks block from nothing, on all our events", () => {
    const merged = mergeHookConfig(undefined, command, hookScript);
    for (const name of HOOK_EVENTS) {
      const entries = merged.hooks[name]!;
      expect(entries).toHaveLength(1);
      const hook = entries[0]!.hooks[0]!;
      expect(hook.type).toBe("command");
      expect(hook.command).toBe(command);
    }
    // SessionStart matches every source (startup/resume/clear/compact)
    expect(merged.hooks.SessionStart![0]!.matcher).toBe("");
  });

  test("preserves unrelated settings and hooks", () => {
    const existing = {
      model: "claude-sonnet-4-5",
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [{ type: "command", command: "echo hi" }],
          },
        ],
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "echo x" }] },
        ],
      },
    };
    const merged = mergeHookConfig(existing, command, hookScript);
    expect(merged.model).toBe("claude-sonnet-4-5");
    expect(JSON.stringify(merged.hooks.PreToolUse)).toBe(
      JSON.stringify(existing.hooks.PreToolUse),
    );
    // the unrelated startup hook stays next to ours
    expect(merged.hooks.SessionStart).toHaveLength(2);
    expect(JSON.stringify(merged.hooks.SessionStart)).toContain("echo hi");
  });

  test("re-running replaces our entries instead of duplicating them", () => {
    const once = mergeHookConfig(undefined, command, hookScript);
    const updatedCommand = command.replace("tok-1", "tok-2");
    const twice = mergeHookConfig(once, updatedCommand, hookScript);
    for (const name of HOOK_EVENTS) {
      expect(twice.hooks[name]).toHaveLength(1);
    }
    expect(JSON.stringify(twice)).toContain("tok-2");
    expect(JSON.stringify(twice)).not.toContain("tok-1");
  });
});

describe("defaultHookScriptPath", () => {
  test("points at the real hook.ts next to this module", () => {
    expect(defaultHookScriptPath().replaceAll("\\", "/")).toMatch(
      /listeners\/claude-code\/src\/hook\.ts$/,
    );
  });
});

describe("removeHookConfig", () => {
  test("removes our entries, keeps unrelated settings and hooks", () => {
    const existing = {
      model: "claude-sonnet-4-5",
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "echo x" }] },
        ],
      },
    };
    const merged = mergeHookConfig(existing, command, hookScript);
    const cleaned = removeHookConfig(merged, hookScript);
    expect(cleaned.model).toBe("claude-sonnet-4-5");
    const hooks = cleaned.hooks as Record<string, unknown[]>;
    for (const name of HOOK_EVENTS) {
      expect(hooks[name]).toBeUndefined();
    }
    expect(hooks.PreToolUse).toHaveLength(1);
  });

  test("is a no-op on a settings file without our hooks", () => {
    const existing = { model: "claude-sonnet-4-5", other: { a: 1 } };
    expect(removeHookConfig(existing, hookScript)).toEqual(existing);
  });
});
