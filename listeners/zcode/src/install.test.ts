import { describe, expect, test } from "bun:test";
import { mergeHookConfig, slopwatchHookEntry } from "./install";

const bunPath = "C:\\bun\\bun.exe";
const spawner = "D:\\repo\\listeners\\zcode\\src\\spawner.ts";
const entry = slopwatchHookEntry({
  bunPath,
  spawnerPath: spawner,
  serverUrl: "http://localhost:8787",
  token: "tok-1",
});

describe("slopwatchHookEntry", () => {
  test("is a process hook passing the session id template variable", () => {
    expect(entry.type).toBe("process");
    expect(entry.command).toBe(bunPath);
    const args = entry.args as string[];
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("${ZCODE_SESSION_ID}");
    expect(args).toContain("--server-url");
    expect(args).toContain("tok-1");
    expect(typeof entry.timeoutMs).toBe("number");
  });
});

describe("mergeHookConfig", () => {
  test("creates the structure from nothing, on both hook events", () => {
    const merged = mergeHookConfig(undefined, entry);
    expect(merged.hooks.enabled).toBe(true);
    for (const name of ["SessionStart", "UserPromptSubmit"]) {
      const entries = merged.hooks.events[name];
      expect(entries).toHaveLength(1);
      expect(entries[0].hooks).toContainEqual(entry);
    }
  });

  test("preserves existing unrelated hooks and config keys", () => {
    const existing = {
      other: { keep: true },
      hooks: {
        enabled: true,
        events: {
          SessionStart: [
            {
              matcher: "startup",
              hooks: [{ type: "command", command: "echo hi" }],
            },
          ],
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "echo x" }],
            },
          ],
        },
      },
    };
    const merged = mergeHookConfig(existing, entry);
    expect(merged.other).toEqual({ keep: true });
    expect(merged.hooks.events.PreToolUse).toEqual(
      existing.hooks.events.PreToolUse,
    );
    const starts = merged.hooks.events.SessionStart;
    expect(starts).toHaveLength(2); // the unrelated one plus ours
    expect(JSON.stringify(starts)).toContain("echo hi");
  });

  test("re-running install replaces our entry instead of duplicating it", () => {
    const once = mergeHookConfig(undefined, entry);
    const twice = mergeHookConfig(once, entry);
    expect(twice.hooks.events.SessionStart).toHaveLength(1);
    expect(twice.hooks.events.UserPromptSubmit).toHaveLength(1);
    // and with changed settings the entry is updated, not appended
    const entry2 = slopwatchHookEntry({
      bunPath,
      spawnerPath: spawner,
      serverUrl: "http://other:9999",
      token: "tok-2",
    });
    const updated = mergeHookConfig(once, entry2);
    expect(updated.hooks.events.SessionStart).toHaveLength(1);
    expect(updated.hooks.events.UserPromptSubmit).toHaveLength(1);
    expect(JSON.stringify(updated)).toContain("tok-2");
    expect(JSON.stringify(updated)).not.toContain("tok-1");
  });
});
