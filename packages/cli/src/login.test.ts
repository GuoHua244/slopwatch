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

type FetchLike = (input?: unknown, init?: unknown) => Promise<Response>;
const asFetch = (fn: FetchLike): typeof fetch => fn as unknown as typeof fetch;

describe("login", () => {
  test("verifies and stores the token, preserving other stored fields", async () => {
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

      // re-login keeps the other stored fields and swaps the token
      const { saveConfig } = await import("@slopwatch/config");
      saveConfig(
        { serverUrl: "http://old:1", token: "old", disabled: true },
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
      expect(config?.serverUrl).toBe(`http://127.0.0.1:${server.port}`);
      expect(config?.disabled).toBe(true);
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

      // no config anywhere: localhost default. The fetch is injected so the
      // test cannot be flipped red by a real server listening on 8787.
      const fresh = tempHome();
      const requested: string[] = [];
      const refusingFetch = asFetch(async (input) => {
        requested.push(String(input));
        throw new Error("connection refused");
      });
      const failed = await login({
        token: "tok",
        homeDir: fresh,
        fetchImpl: refusingFetch,
      });
      expect(failed.ok).toBe(false);
      if (!failed.ok) {
        expect(failed.error).toContain("server unreachable");
        expect(failed.error).toContain("nothing written");
      }
      expect(requested).toEqual(["http://localhost:8787/me"]);
      expect(loadConfig(fresh)).toBeNull();
    } finally {
      server.stop(true);
    }
  });
});
