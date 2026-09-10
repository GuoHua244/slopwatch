import { describe, expect, test } from "bun:test";
import { loadConfig, saveConfig } from "@slopwatch/config";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login } from "./login";

const meServer = (status: number) =>
  Bun.serve({
    port: 0,
    fetch: () =>
      status === 200
        ? Response.json({ user: "alice", is_dri: false })
        : Response.json({ error: "x" }, { status }),
  });

const tempHome = (): string => mkdtempSync(join(tmpdir(), "slopwatch-login-"));

describe("login", () => {
  test("verifies and stores the token, preserving a summary block", async () => {
    const server = meServer(200);
    const home = tempHome();
    try {
      const result = await login({
        token: "tok-1",
        serverUrl: `http://127.0.0.1:${server.port}`,
        homeDir: home,
      });
      expect(result).toEqual({
        ok: true,
        user: "alice",
        isDri: false,
        serverUrl: `http://127.0.0.1:${server.port}`,
      });
      expect(loadConfig(home)?.token).toBe("tok-1");

      // re-login keeps the summary block and swaps the token
      const { saveConfig } = await import("@slopwatch/config");
      saveConfig(
        {
          serverUrl: "http://old:1",
          token: "old",
          summary: { endpoint: "https://e/v1", model: "m", apiKey: "k" },
        },
        home,
      );
      const second = await login({
        token: "tok-2",
        serverUrl: `http://127.0.0.1:${server.port}`,
        homeDir: home,
      });
      expect(second.ok).toBe(true);
      const config = loadConfig(home);
      expect(config?.token).toBe("tok-2");
      expect(config?.summary?.model).toBe("m");
    } finally {
      server.stop(true);
    }
  });

  test("writes nothing when the token is rejected", async () => {
    const server = meServer(401);
    const home = tempHome();
    try {
      const result = await login({
        token: "bad",
        serverUrl: `http://127.0.0.1:${server.port}`,
        homeDir: home,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("nothing written");
      expect(loadConfig(home)).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("defaults the server URL to the stored config, then localhost", async () => {
    const server = meServer(200);
    const home = tempHome();
    const { saveConfig } = await import("@slopwatch/config");
    saveConfig(
      { serverUrl: `http://127.0.0.1:${server.port}`, token: "old" },
      home,
    );
    try {
      // no --server-url: the stored config's server is used
      const result = await login({ token: "tok", homeDir: home });
      expect(result).toEqual({
        ok: true,
        user: "alice",
        isDri: false,
        serverUrl: `http://127.0.0.1:${server.port}`,
      });

      // no config anywhere: localhost default (unreachable here → error)
      const fresh = tempHome();
      const failed = await login({ token: "tok", homeDir: fresh });
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.error).toContain("server unreachable");
    } finally {
      server.stop(true);
    }
  });
});
