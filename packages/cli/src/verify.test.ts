import { describe, expect, test } from "bun:test";
import { verifyToken } from "./verify";

const meServer = (statusForAuth: Record<string, number> = {}) =>
  Bun.serve({
    port: 0,
    fetch: (req) => {
      const bearer = req.headers.get("authorization")?.replace("Bearer ", "");
      const status = bearer ? (statusForAuth[bearer] ?? 200) : 200;
      if (status !== 200) return Response.json({ error: "x" }, { status });
      return Response.json({ user: "alice", is_dri: bearer === "dri-token" });
    },
  });

describe("verifyToken", () => {
  test("accepts a valid token and reports the user", async () => {
    const server = meServer();
    try {
      const result = await verifyToken(
        `http://127.0.0.1:${server.port}`,
        "good-token",
      );
      expect(result).toEqual({ ok: true, user: "alice", isDri: false });
    } finally {
      server.stop(true);
    }
  });

  test("flags DRIs", async () => {
    const server = meServer();
    try {
      const result = await verifyToken(
        `http://127.0.0.1:${server.port}`,
        "dri-token",
      );
      expect(result).toEqual({ ok: true, user: "alice", isDri: true });
    } finally {
      server.stop(true);
    }
  });

  test("rejects a 401 with a clear error", async () => {
    const server = meServer({ bad: 401 });
    try {
      const result = await verifyToken(
        `http://127.0.0.1:${server.port}`,
        "bad",
      );
      expect(result).toEqual({
        ok: false,
        error: "the server rejected this token (401)",
      });
    } finally {
      server.stop(true);
    }
  });

  test("reports an unreachable server", async () => {
    const server = meServer();
    const port = server.port;
    server.stop(true);
    const result = await verifyToken(`http://127.0.0.1:${port}`, "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("server unreachable");
  });

  test("reports an unexpected response shape", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ surprise: true }),
    });
    try {
      const result = await verifyToken(`http://127.0.0.1:${server.port}`, "t");
      expect(result).toEqual({
        ok: false,
        error: "unexpected /me response shape",
      });
    } finally {
      server.stop(true);
    }
  });
});
