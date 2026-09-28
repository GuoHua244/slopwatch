import { describe, expect, test } from "bun:test";
import { loadConfig } from "@slopwatch/config";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeUserSettingsPath, zcodeUserConfigPath } from "./detect";
import { runInstall } from "./install";

// A stand-in Server: /me answers like the real one, everything else 404s.
const meServer = Bun.serve({
  port: 0,
  fetch: (req) => {
    if (req.url.endsWith("/me") && req.headers.get("authorization")) {
      return Response.json({ user: "alice", is_dri: false });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
});
const serverUrl = `http://127.0.0.1:${meServer.port}`;

const tempHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "slopwatch-install-"));
  // both hosts "installed" — their home dirs exist
  mkdirSync(join(home, ".zcode"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
};

describe("runInstall", () => {
  test("without credentials it refuses and writes nothing", async () => {
    const home = tempHome();
    const result = await runInstall({ homeDir: home });
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("--token");
    expect(existsSync(zcodeUserConfigPath(home))).toBe(false);
    expect(existsSync(claudeUserSettingsPath(home))).toBe(false);
  });

  test("verifies the token, stores it, and wires both hosts user-scope", async () => {
    const home = tempHome();
    const result = await runInstall({
      token: "tok-1",
      serverUrl,
      homeDir: home,
    });
    expect(result.ok).toBe(true);
    expect(result.lines.join("\n")).toContain("token verified (alice)");

    const config = loadConfig(home);
    expect(config?.token).toBe("tok-1");
    expect(config?.serverUrl).toBe(serverUrl);

    // zcode: user-level hook config with our entry and no embedded token
    const zcodeConfig = JSON.parse(
      readFileSync(zcodeUserConfigPath(home), "utf8"),
    );
    expect(zcodeConfig.hooks.enabled).toBe(true);
    const zcodeArgs = zcodeConfig.hooks.events.SessionStart[0].hooks[0]
      .args as string[];
    expect(zcodeArgs[0].replaceAll("\\", "/")).toMatch(/spawner\.ts$/);
    expect(JSON.stringify(zcodeConfig)).not.toContain("tok-1");

    // claude-code: user-level settings with our command and no token
    const claudeSettings = JSON.parse(
      readFileSync(claudeUserSettingsPath(home), "utf8"),
    );
    expect(claudeSettings.hooks.SessionStart[0].hooks[0].command).toContain(
      "hook.ts",
    );
    expect(JSON.stringify(claudeSettings)).not.toContain("tok-1");
  });

  test("is idempotent — wiring twice leaves one entry per event", async () => {
    const home = tempHome();
    const opts = { token: "tok-1", serverUrl, homeDir: home };
    await runInstall(opts);
    await runInstall({ ...opts, token: "tok-2" });
    const zcodeConfig = JSON.parse(
      readFileSync(zcodeUserConfigPath(home), "utf8"),
    );
    expect(zcodeConfig.hooks.events.SessionStart).toHaveLength(1);
    expect(zcodeConfig.hooks.events.UserPromptSubmit).toHaveLength(1);
    const claudeSettings = JSON.parse(
      readFileSync(claudeUserSettingsPath(home), "utf8"),
    );
    for (const event of ["SessionStart", "UserPromptSubmit", "SessionEnd"]) {
      expect(claudeSettings.hooks[event]).toHaveLength(1);
    }
    expect(loadConfig(home)?.token).toBe("tok-2");
  });

  test("--agent restricts wiring", async () => {
    const home = tempHome();
    const result = await runInstall({
      token: "tok-1",
      serverUrl,
      homeDir: home,
      agents: ["zcode"],
    });
    expect(result.ok).toBe(true);
    expect(existsSync(zcodeUserConfigPath(home))).toBe(true);
    expect(existsSync(claudeUserSettingsPath(home))).toBe(false);
  });

  test("unknown agent names are rejected", async () => {
    const home = tempHome();
    const result = await runInstall({
      token: "tok-1",
      homeDir: home,
      agents: ["codex"],
    });
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("codex");
  });

  test("a rejected token stops everything before any wiring", async () => {
    const home = tempHome();
    const result = await runInstall({
      token: "bad",
      serverUrl: "http://127.0.0.1:1", // nothing listens here
      homeDir: home,
    });
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("nothing written");
    expect(existsSync(zcodeUserConfigPath(home))).toBe(false);
    expect(existsSync(claudeUserSettingsPath(home))).toBe(false);
  });

  test("a corrupt target file aborts instead of clobbering it", async () => {
    const home = tempHome();
    const settings = claudeUserSettingsPath(home);
    writeFileSync(settings, "{corrupt");
    const result = await runInstall({
      token: "tok-1",
      serverUrl,
      homeDir: home,
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(settings, "utf8")).toBe("{corrupt");
  });
});
