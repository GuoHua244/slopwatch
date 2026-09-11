import { describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEARTBEAT_TTL_MS, isSidecarAlive } from "./liveness";

// A PID that is guaranteed dead: spawn a process synchronously — spawnSync
// only returns after it has exited. (Any hardcoded PID could be reused by a
// stranger — the exact hazard under test.)
const deadPid = (): number => Bun.spawnSync(["cmd", "/c", "exit"]).pid;

const touch = (path: string, ageMs = 0): void => {
  closeSync(openSync(path, "w"));
  if (ageMs !== 0) {
    const t = new Date(Date.now() - ageMs);
    utimesSync(path, t, t);
  }
};

describe("isSidecarAlive", () => {
  const heartbeat = (): string =>
    join(mkdtempSync(join(tmpdir(), "slopwatch-liveness-")), "heartbeat");

  test("live PID with a fresh heartbeat is alive", () => {
    const file = heartbeat();
    touch(file);
    expect(isSidecarAlive({ pid: process.pid, heartbeatFile: file })).toBe(
      true,
    );
  });

  test("dead PID is not alive even with a fresh heartbeat", () => {
    const file = heartbeat();
    touch(file);
    expect(isSidecarAlive({ pid: deadPid(), heartbeatFile: file })).toBe(false);
  });

  test("live PID without a heartbeat is not alive (pre-heartbeat sidecar)", () => {
    expect(
      isSidecarAlive({
        pid: process.pid,
        heartbeatFile: join(heartbeat(), "never-written"),
      }),
    ).toBe(false);
  });

  test("stale heartbeat is not alive", () => {
    const file = heartbeat();
    touch(file, HEARTBEAT_TTL_MS + 60_000);
    expect(isSidecarAlive({ pid: process.pid, heartbeatFile: file })).toBe(
      false,
    );
  });

  test("heartbeat exactly at the TTL boundary is already stale", () => {
    const file = heartbeat();
    touch(file, HEARTBEAT_TTL_MS);
    expect(isSidecarAlive({ pid: process.pid, heartbeatFile: file })).toBe(
      false,
    );
  });
});
