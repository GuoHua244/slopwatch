/**
 * Install tests. The installer runs on a file the user already owns, so the
 * property that matters is non-destructiveness: their keys, their plugins and
 * their own hooks have to survive our merge untouched — and re-running must
 * replace our entries rather than pile them up.
 */
import { describe, expect, test } from "bun:test";
import {
  HOOK_EVENTS,
  codebuddyProjectSettingsPath,
  codebuddyUserSettingsPath,
  isOurEntry,
  mergeHookConfig,
  removeHookConfig,
  slopwatchHookCommand,
} from "./install";

const HOOK = "C:\\slopwatch\\hook.ts";
const COMMAND = slopwatchHookCommand({
  bunPath: "C:\\bun.exe",
  hookScriptPath: HOOK,
  serverUrl: "http://localhost:8787",
  token: "tok",
});

/** A settings file no installer wrote: a user's own hooks and preferences. */
const existing: Record<string, unknown> = {
  enabledPlugins: { "pptx@codebuddy-plugins-official": true },
  hooks: {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "my-own-guard.sh", timeout: 10 }],
      },
    ],
    Stop: [
      { hooks: [{ type: "command", command: "notify-me.sh", timeout: 5 }] },
    ],
  },
  someFutureKey: { nested: true },
};

type HookList = { hooks: { command: string }[] }[];

const hooksOf = (settings: Record<string, unknown>): Record<string, unknown> =>
  settings.hooks as Record<string, unknown>;

const asHookList = (value: unknown): HookList | undefined =>
  value as HookList | undefined;

describe("mergeHookConfig", () => {
  test("keeps every unrelated key and every unrelated hook", () => {
    const merged = mergeHookConfig(existing, COMMAND, HOOK);
    expect(merged.enabledPlugins).toEqual(existing.enabledPlugins);
    expect(merged.someFutureKey).toEqual({ nested: true });
    expect(hooksOf(merged).PreToolUse).toEqual([
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "my-own-guard.sh", timeout: 10 }],
      },
    ]);
    // Stop is NOT one of our events (this host never fires it), so the user's
    // own Stop hook is untouched — we do not even lengthen their array
    const stops = asHookList(hooksOf(merged).Stop);
    expect(stops).toHaveLength(1);
    expect(stops?.[0]?.hooks[0]?.command).toBe("notify-me.sh");
  });

  test("registers exactly our four events", () => {
    const merged = mergeHookConfig(existing, COMMAND, HOOK);
    for (const event of HOOK_EVENTS) {
      const entries = merged.hooks[event] as unknown[];
      expect(entries).toBeDefined();
      expect(entries?.some((e) => isOurEntry(e, HOOK))).toBe(true);
    }
  });

  test("is idempotent — a second run replaces our entry instead of duplicating", () => {
    const once = mergeHookConfig(existing, COMMAND, HOOK);
    const twice = mergeHookConfig(once, COMMAND, HOOK);
    for (const event of HOOK_EVENTS) {
      const entries = twice.hooks[event] as unknown[];
      const ours = entries.filter((e) => isOurEntry(e, HOOK));
      expect(ours).toHaveLength(1);
    }
    // the user's own hooks did not multiply either
    expect(twice.hooks.PreToolUse as unknown[]).toHaveLength(1);
  });

  test("an install from a moved script adds its own entry and leaves the old one", () => {
    const once = mergeHookConfig(existing, COMMAND, HOOK);
    const movedPath = "D:\\moved\\hook.ts";
    const moved = slopwatchHookCommand({
      bunPath: "D:\\other-bun.exe",
      hookScriptPath: movedPath,
    });
    const twice = mergeHookConfig(once, moved, movedPath);
    for (const event of HOOK_EVENTS) {
      const entries = twice.hooks[event] as unknown[];
      // the moved install is registered…
      expect(entries.filter((e) => isOurEntry(e, movedPath))).toHaveLength(1);
      // …and the previous script's entry is another hook's business, not ours
      // to delete — only a re-install from the SAME script replaces it
      expect(entries.filter((e) => isOurEntry(e, HOOK))).toHaveLength(1);
    }
  });

  test("creates the hooks block from nothing", () => {
    const merged = mergeHookConfig(undefined, COMMAND, HOOK);
    expect(Object.keys(merged.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
  });
});

describe("removeHookConfig", () => {
  test("removes only our entries and drops events that empty out", () => {
    const merged = mergeHookConfig(existing, COMMAND, HOOK);
    const cleaned = removeHookConfig(merged, HOOK);
    const cleanedHooks = hooksOf(cleaned);
    // our events are gone (Stop keeps the user's own hook)
    expect(cleanedHooks.SessionStart).toBeUndefined();
    expect(cleanedHooks.PostToolUse).toBeUndefined();
    expect(asHookList(cleanedHooks.Stop)?.[0]?.hooks[0]?.command).toBe(
      "notify-me.sh",
    );
    expect(cleaned.enabledPlugins).toEqual(existing.enabledPlugins);
  });

  test("leaves a settings file we never touched alone", () => {
    const untouched = removeHookConfig(existing, HOOK);
    expect(hooksOf(untouched)).toEqual(
      existing.hooks as Record<string, unknown>,
    );
  });
});

describe("settings paths", () => {
  test("user scope is ~/.codebuddy/settings.json, project scope <dir>/.codebuddy", () => {
    expect(codebuddyUserSettingsPath("C:\\Users\\me")).toBe(
      "C:\\Users\\me\\.codebuddy\\settings.json",
    );
    expect(codebuddyProjectSettingsPath("D:\\repo")).toBe(
      "D:\\repo\\.codebuddy\\settings.json",
    );
  });
});
