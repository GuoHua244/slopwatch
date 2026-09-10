import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENTS,
  claudeProjectSettingsPath,
  claudeUserSettingsPath,
  detectAgents,
  zcodeUserConfigPath,
  zcodeWorkspaceConfigPath,
} from "./detect";

const tempHome = (): string => mkdtempSync(join(tmpdir(), "slopwatch-detect-"));

describe("detectAgents", () => {
  test("nothing detected in an empty home", () => {
    expect(detectAgents(tempHome())).toEqual({
      zcode: false,
      "claude-code": false,
    });
  });

  test("detects each host by its home directory", () => {
    const home = tempHome();
    mkdirSync(join(home, ".zcode"), { recursive: true });
    expect(detectAgents(home).zcode).toBe(true);
    expect(detectAgents(home)["claude-code"]).toBe(false);
    mkdirSync(join(home, ".claude"), { recursive: true });
    expect(detectAgents(home)["claude-code"]).toBe(true);
  });
});

describe("wiring targets", () => {
  test("user scope lands under the home, project scope under --dir", () => {
    expect(zcodeUserConfigPath("/home")).toBe(
      join("/home", ".zcode", "cli", "config.json"),
    );
    expect(zcodeWorkspaceConfigPath("/repo")).toBe(
      join("/repo", ".zcode", "config.json"),
    );
    expect(claudeUserSettingsPath("/home")).toBe(
      join("/home", ".claude", "settings.json"),
    );
    expect(claudeProjectSettingsPath("/repo")).toBe(
      join("/repo", ".claude", "settings.json"),
    );
  });

  test("the agent catalog is the wiring order", () => {
    expect(AGENTS).toEqual(["zcode", "claude-code"]);
  });
});
