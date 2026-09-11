import { describe, expect, test } from "bun:test";
import { loadConfig, saveConfig } from "@slopwatch/config";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCapturePaused } from "./pause";

const tempHome = (): string => mkdtempSync(join(tmpdir(), "slopwatch-pause-"));

describe("setCapturePaused", () => {
  test("with no config it fails with a hint", () => {
    const result = setCapturePaused(true, tempHome());
    expect(result.ok).toBe(false);
    expect(result.lines[0]).toContain("install");
  });

  test("pause/resume flip the flag and are idempotent", () => {
    const home = tempHome();
    saveConfig({ serverUrl: "http://localhost:8787", token: "tok" }, home);
    const first = setCapturePaused(true, home);
    expect(first.ok).toBe(true);
    expect(loadConfig(home)?.disabled).toBe(true);

    const again = setCapturePaused(true, home);
    expect(again.ok).toBe(true);
    expect(again.lines[0]).toContain("already paused");

    const back = setCapturePaused(false, home);
    expect(back.ok).toBe(true);
    expect(loadConfig(home)?.disabled).toBeUndefined();

    const reAgain = setCapturePaused(false, home);
    expect(reAgain.lines[0]).toContain("already running");
  });

  test("pausing keeps the rest of the config intact", () => {
    const home = tempHome();
    saveConfig({ serverUrl: "http://localhost:8787", token: "tok" }, home);
    const result = setCapturePaused(true, home);
    expect(result.ok).toBe(true);
    const config = loadConfig(home);
    expect(config?.serverUrl).toBe("http://localhost:8787");
    expect(config?.token).toBe("tok");
    expect(config?.disabled).toBe(true);
  });
});
