import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configFilePath,
  loadConfig,
  redactConfig,
  resolveShipConfig,
  saveConfig,
  type SlopwatchConfig,
} from "./config";

const tempHome = (): string => mkdtempSync(join(tmpdir(), "slopwatch-config-"));

/** Write a raw config file into a temp home, creating .slopwatch first. */
const writeRawConfig = (home: string, body: string): void => {
  mkdirSync(join(home, ".slopwatch"), { recursive: true });
  writeFileSync(configFilePath(home), body);
};

const example = (): SlopwatchConfig => ({
  serverUrl: "http://localhost:8787",
  token: "sw_token_abcdef",
});

describe("configFilePath", () => {
  test("joins .slopwatch/config.json under the given home", () => {
    expect(configFilePath(join("/home", "dev"))).toBe(
      join("/home", "dev", ".slopwatch", "config.json"),
    );
  });
});

describe("loadConfig/saveConfig", () => {
  test("round-trips a saved config", () => {
    const home = tempHome();
    saveConfig(example(), home);
    expect(loadConfig(home)).toEqual(example());
  });

  test("returns null when no config file exists", () => {
    expect(loadConfig(tempHome())).toBeNull();
  });

  test("returns null when the config file is corrupt", () => {
    const home = tempHome();
    writeRawConfig(home, "{not json");
    expect(loadConfig(home)).toBeNull();
  });

  test("warns when the config file is corrupt, stays silent when missing", () => {
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      // missing file: silent — stdout mode is a normal state
      expect(loadConfig(tempHome())).toBeNull();
      expect(errors).toEqual([]);

      // existing but unparsable: warned, still null
      const home = tempHome();
      writeRawConfig(home, "{not json");
      expect(loadConfig(home)).toBeNull();
      expect(errors.length).toBe(1);
      expect(errors[0]![0]).toBe(
        "slopwatch config file is corrupt and was ignored:",
      );
      expect(errors[0]![1]).toBe(configFilePath(home));
    } finally {
      console.error = originalError;
    }
  });

  test("returns null when serverUrl or token are missing or empty", () => {
    const home = tempHome();
    writeRawConfig(home, JSON.stringify({ serverUrl: "x" }));
    expect(loadConfig(home)).toBeNull();
    writeRawConfig(home, JSON.stringify({ token: "t", serverUrl: "" }));
    expect(loadConfig(home)).toBeNull();
  });

  test("ignores unknown keys such as the removed summary block", () => {
    const home = tempHome();
    writeRawConfig(
      home,
      JSON.stringify({
        serverUrl: "u",
        token: "t",
        summary: { endpoint: "e", model: "m", apiKey: "k" },
      }),
    );
    expect(loadConfig(home)).toEqual({ serverUrl: "u", token: "t" });
  });

  test("saved file is 0600 on posix", () => {
    if (process.platform === "win32") return;
    const home = tempHome();
    saveConfig(example(), home);
    expect(statSync(configFilePath(home)).mode & 0o777).toBe(0o600);
  });

  test("config file exists after save", () => {
    const home = tempHome();
    saveConfig(example(), home);
    expect(existsSync(configFilePath(home))).toBe(true);
    expect(readFileSync(configFilePath(home), "utf8")).toContain("serverUrl");
  });
});

describe("resolveShipConfig", () => {
  test("a complete argv pair wins over the config file", () => {
    const home = tempHome();
    saveConfig(example(), home);
    expect(
      resolveShipConfig(
        { serverUrl: "http://override:1", token: "argv-token" },
        home,
      ),
    ).toEqual({ serverUrl: "http://override:1", token: "argv-token" });
  });

  test("falls back to the config file when argv is empty", () => {
    const home = tempHome();
    saveConfig(example(), home);
    expect(resolveShipConfig({}, home)).toEqual({
      serverUrl: "http://localhost:8787",
      token: "sw_token_abcdef",
    });
  });

  test("a partial argv pair falls back to the config file wholesale", () => {
    const home = tempHome();
    saveConfig(example(), home);
    expect(resolveShipConfig({ serverUrl: "http://override:1" }, home)).toEqual(
      { serverUrl: "http://localhost:8787", token: "sw_token_abcdef" },
    );
  });

  test("returns null with no argv pair and no config file", () => {
    expect(resolveShipConfig({}, tempHome())).toBeNull();
  });

  test("resolves SLOPWATCH_HOME when no home param is given", () => {
    const home = tempHome();
    saveConfig(example(), home);
    const previous = process.env.SLOPWATCH_HOME;
    process.env.SLOPWATCH_HOME = home;
    try {
      expect(resolveShipConfig({})).toEqual({
        serverUrl: "http://localhost:8787",
        token: "sw_token_abcdef",
      });
    } finally {
      if (previous === undefined) delete process.env.SLOPWATCH_HOME;
      else process.env.SLOPWATCH_HOME = previous;
    }
  });
});

describe("redactConfig", () => {
  test("masks the token, keeps the rest", () => {
    expect(redactConfig(example())).toEqual({
      serverUrl: "http://localhost:8787",
      token: "sw_t…",
    });
  });
});

describe("capture kill switch", () => {
  test("disabled round-trips and clears when omitted", () => {
    const home = mkdtempSync(join(tmpdir(), "slopwatch-cfg-switch-"));
    saveConfig(
      { serverUrl: "http://localhost:8787", token: "t", disabled: true },
      home,
    );
    expect(loadConfig(home)?.disabled).toBe(true);

    saveConfig({ serverUrl: "http://localhost:8787", token: "t" }, home);
    expect(loadConfig(home)?.disabled).toBeUndefined();
  });
});
