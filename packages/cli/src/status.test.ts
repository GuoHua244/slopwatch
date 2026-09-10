import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstall } from "./install";
import { statusReport } from "./status";

// both hosts "installed" — detection is home-directory based
const tempHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "slopwatch-status-"));
  mkdirSync(join(home, ".zcode"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
};

describe("statusReport", () => {
  test("an empty machine reports no credentials and no detection", () => {
    // bare home — no host directories at all
    const lines = statusReport({
      homeDir: mkdtempSync(join(tmpdir(), "slopwatch-status-bare-")),
    });
    const text = lines.join("\n");
    expect(text).toContain("credentials: none");
    expect(text).toContain("zcode: not detected");
    expect(text).toContain("claude-code: not detected");
  });

  test("after a real install, both hosts report wired and the token is redacted", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ user: "alice", is_dri: false }),
    });
    const home = tempHome();
    try {
      const result = await runInstall({
        token: "sw_secret_token_value",
        serverUrl: `http://127.0.0.1:${server.port}`,
        homeDir: home,
      });
      expect(result.ok).toBe(true);

      const text = statusReport({ homeDir: home }).join("\n");
      expect(text).toContain("wired");
      expect(text).toContain("sw_s…");
      expect(text).not.toContain("sw_secret_token_value");
    } finally {
      server.stop(true);
    }
  });

  test("detected but unwired hosts say so", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ user: "alice", is_dri: false }),
    });
    const home = tempHome();
    try {
      await runInstall({
        token: "tok",
        serverUrl: `http://127.0.0.1:${server.port}`,
        homeDir: home,
        agents: ["zcode"],
      });
      const text = statusReport({ homeDir: home }).join("\n");
      expect(text).toContain("zcode: detected · user-scope hooks wired");
      expect(text).toContain(
        "claude-code: detected · user-scope hooks not wired",
      );
    } finally {
      server.stop(true);
    }
  });
});
