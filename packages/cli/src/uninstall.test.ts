import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstall } from "./install";
import { runUninstall } from "./uninstall";

const tempHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "slopwatch-uninstall-"));
  mkdirSync(join(home, ".zcode"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
};

const installAll = async (home: string): Promise<void> => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ user: "alice", is_dri: false }),
  });
  try {
    const result = await runInstall({
      token: "tok-1",
      serverUrl: `http://127.0.0.1:${server.port}`,
      homeDir: home,
    });
    expect(result.ok).toBe(true);
  } finally {
    server.stop(true);
  }
};

describe("runUninstall", () => {
  test("removes our hooks from both hosts and keeps unrelated settings", async () => {
    const home = tempHome();
    await installAll(home);
    // unrelated settings the merge must preserve through uninstall
    const { claudeUserSettingsPath } = await import("./detect");
    const settingsPath = claudeUserSettingsPath(home);
    const withUnrelated = {
      ...JSON.parse(readFileSync(settingsPath, "utf8")),
      model: "claude-sonnet-4-5",
    };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(settingsPath, JSON.stringify(withUnrelated, null, 2));

    const result = runUninstall({ homeDir: home });
    expect(result.ok).toBe(true);

    const zcodeConfig = JSON.parse(
      readFileSync(join(home, ".zcode", "cli", "config.json"), "utf8"),
    );
    expect(zcodeConfig.hooks.events.SessionStart).toBeUndefined();
    expect(zcodeConfig.hooks.events.UserPromptSubmit).toBeUndefined();

    const cleaned = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(cleaned.model).toBe("claude-sonnet-4-5");
    expect(cleaned.hooks.SessionStart).toBeUndefined();
    expect(cleaned.hooks.SessionEnd).toBeUndefined();
  });

  test("status flips to not wired after uninstall", async () => {
    const { statusReport } = await import("./status");
    const home = tempHome();
    await installAll(home);
    expect(statusReport({ homeDir: home }).join("\n")).toContain("wired");
    runUninstall({ homeDir: home });
    const text = statusReport({ homeDir: home }).join("\n");
    expect(text).toContain("zcode: detected · user-scope hooks not wired");
    expect(text).toContain(
      "claude-code: detected · user-scope hooks not wired",
    );
  });

  test("uninstall without anything installed still succeeds", () => {
    // a bare home: hosts not even detected
    const result = runUninstall({
      homeDir: mkdtempSync(join(tmpdir(), "slopwatch-uninstall-bare-")),
    });
    expect(result.ok).toBe(true);
    expect(result.lines.join("\n")).toContain("not detected");
  });

  test("an unknown agent is rejected", () => {
    const result = runUninstall({ homeDir: tempHome(), agents: ["copilot"] });
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("copilot");
  });

  test("credentials file survives uninstall", async () => {
    const { loadConfig } = await import("@slopwatch/config");
    const home = tempHome();
    await installAll(home);
    runUninstall({ homeDir: home });
    expect(loadConfig(home)?.token).toBe("tok-1");
    expect(existsSync(join(home, ".slopwatch", "config.json"))).toBe(true);
  });
});
