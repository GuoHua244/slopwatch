import { describe, expect, test } from "bun:test";
import {
  defaultHookScriptPath,
  isOurEntry,
  mergeHookConfig,
  removeHookConfig,
  slopwatchHookCommand,
} from "./install";

const scriptPath = defaultHookScriptPath();
const command = slopwatchHookCommand({
  bunPath: "C:\\Tools\\bun.exe",
  hookScriptPath: scriptPath,
});

describe("codex install mergeHookConfig", () => {
  test("creates the five events with our entries", () => {
    const merged = mergeHookConfig(undefined, command, scriptPath);
    const hooks = merged.hooks as Record<string, unknown>;
    for (const event of [
      "SessionStart",
      "UserPromptSubmit",
      "PostToolUse",
      "Stop",
      "SessionEnd",
    ]) {
      const entries = hooks[event] as {
        matcher?: string;
        hooks: { command: string; timeout: number; statusMessage?: string }[];
      }[];
      expect(entries.length).toBe(1);
      expect(entries[0]!.matcher).toBe("");
      // the command embeds the script path JSON-quoted (backslashes escaped)
      expect(entries[0]!.hooks[0]!.command).toContain(
        JSON.stringify(scriptPath),
      );
      expect(entries[0]!.hooks[0]!.statusMessage).toBe("slopwatch capture");
    }
    // codex clamps SessionEnd hooks to 3s — our entry stays inside the clamp
    const endEntry = (
      hooks.SessionEnd as {
        hooks: { timeout: number }[];
      }[]
    )[0]!.hooks[0]!;
    expect(endEntry.timeout).toBe(3);
    const startEntry = (
      hooks.SessionStart as {
        hooks: { timeout: number }[];
      }[]
    )[0]!.hooks[0]!;
    expect(startEntry.timeout).toBe(10);
  });

  test("is idempotent — re-running replaces instead of duplicating", () => {
    const once = mergeHookConfig(undefined, command, scriptPath);
    const twice = mergeHookConfig(once, command, scriptPath);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  test("preserves unrelated keys, events, and hooks", () => {
    const existing = {
      model_reasoning_effort: "high",
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "powershell -File C:\\other\\hook.ps1",
              },
            ],
          },
        ],
      },
    };
    const merged = mergeHookConfig(existing, command, scriptPath);
    expect(merged.model_reasoning_effort).toBe("high");
    const hooks = merged.hooks as Record<string, unknown[]>;
    expect((hooks.PreToolUse as unknown[]).length).toBe(1); // untouched
    expect(Object.keys(hooks).sort()).toEqual([
      "PostToolUse",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
  });

  test("quotes the bun path so cmd.exe resolves a spaced path", () => {
    const spaced = slopwatchHookCommand({
      bunPath: "C:\\Program Files\\Bun\\bun.exe",
      hookScriptPath: "D:\\my tools\\hook.ts",
    });
    // JSON.stringify quoting: codex JSON-parses the config, so cmd.exe sees
    // the real spaced path at fire time
    expect(spaced).toContain(JSON.stringify("C:\\Program Files\\Bun\\bun.exe"));
    expect(spaced).toContain(JSON.stringify("D:\\my tools\\hook.ts"));
  });
});

describe("codex install removeHookConfig", () => {
  test("removes ours, keeps unrelated entries in shared events", () => {
    const ours = mergeHookConfig(undefined, command, scriptPath);
    const withForeign = mergeHookConfig(
      ours,
      slopwatchHookCommand({
        bunPath: "C:\\Tools\\bun.exe",
        hookScriptPath: "C:\\foreign\\hook.ts",
      }),
      "C:\\foreign\\hook.ts",
    );
    const cleaned = removeHookConfig(withForeign, scriptPath);
    const hooks = cleaned.hooks as Record<string, unknown[]>;
    // every wired event keeps exactly the foreign entry it shared with ours
    for (const event of [
      "SessionStart",
      "UserPromptSubmit",
      "PostToolUse",
      "Stop",
      "SessionEnd",
    ]) {
      expect((hooks[event] as unknown[]).length).toBe(1);
    }
  });

  test("returns the input unchanged when nothing of ours exists", () => {
    const existing = {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "other" }] }] },
    };
    const cleaned = removeHookConfig(existing, scriptPath);
    expect(JSON.stringify(cleaned)).toBe(JSON.stringify(existing));
  });
});

describe("codex install isOurEntry", () => {
  test("matches the plain and quoted script path", () => {
    const entry = {
      matcher: "",
      hooks: [
        { type: "command", command: `bun ${JSON.stringify(scriptPath)}` },
      ],
    };
    expect(isOurEntry(entry, scriptPath)).toBe(true);
    expect(isOurEntry(entry, "C:\\other\\hook.ts")).toBe(false);
    expect(isOurEntry(null, scriptPath)).toBe(false);
    expect(isOurEntry({ hooks: "nope" }, scriptPath)).toBe(false);
  });
});
