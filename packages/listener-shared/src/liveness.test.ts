import { describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEARTBEAT_TTL_MS, isListenerAlive } from "./liveness";

const touch = (path: string, ageMs = 0): void => {
  closeSync(openSync(path, "w"));
  if (ageMs !== 0) {
    const t = new Date(Date.now() - ageMs);
    utimesSync(path, t, t);
  }
};

describe("isListenerAlive", () => {
  const heartbeat = (): string =>
    join(mkdtempSync(join(tmpdir(), "slopwatch-liveness-")), "heartbeat");

  test("fresh heartbeat is alive", () => {
    const file = heartbeat();
    touch(file);
    expect(isListenerAlive({ heartbeatFile: file })).toBe(true);
  });

  test("missing heartbeat file is not alive", () => {
    expect(
      isListenerAlive({ heartbeatFile: join(heartbeat(), "never-written") }),
    ).toBe(false);
  });

  test("stale heartbeat is not alive", () => {
    const file = heartbeat();
    touch(file, HEARTBEAT_TTL_MS + 60_000);
    expect(isListenerAlive({ heartbeatFile: file })).toBe(false);
  });

  test("heartbeat exactly at the TTL boundary is already stale", () => {
    const file = heartbeat();
    touch(file, HEARTBEAT_TTL_MS);
    expect(isListenerAlive({ heartbeatFile: file })).toBe(false);
  });

  test("heartbeat freshness, not wall clock: an old file just written is fresh", () => {
    // the spawner pre-writes the heartbeat before the child can boot — a
    // generation whose process died in that window stays "alive" for at
    // most one TTL; the cursor backfill at the eventual respawn makes this
    // a capture delay, never a data loss
    const file = heartbeat();
    touch(file, HEARTBEAT_TTL_MS - 1_000);
    expect(isListenerAlive({ heartbeatFile: file })).toBe(true);
  });
});
