import { describe, expect, test } from "bun:test";
import { mkdtempSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { codexLocksDir, createCodexLockWatcher } from "./thread-locks";

const makeLocksDir = (): string =>
  mkdtempSync(join(tmpdir(), "slopwatch-locks-"));

const lock = (dir: string, id: string): string => join(dir, `${id}.lock`);

describe("codex lock watcher", () => {
  test("baseline records without touching; live mtime changes bump their session", () => {
    const dir = makeLocksDir();
    const touchedId = "01a1aaaa-1111-2222-3333-444444444444";
    const quietId = "01a1bbbb-1111-2222-3333-444444444444";
    // both locks exist before the watcher — they are the restart baseline
    writeFileSync(lock(dir, touchedId), "");
    writeFileSync(lock(dir, quietId), "");
    const touched: string[] = [];
    const watcher = createCodexLockWatcher({
      store: {
        touchSession: async (id) => {
          touched.push(id);
          return true;
        },
      },
      dir,
      pollMs: 3_600_000, // the interval must never fire inside the test
      log: () => {},
    });
    try {
      expect(watcher.active).toBe(true);
      watcher.sweep();
      expect(touched).toEqual([]);

      // a touch — the Codex app opening the thread — bumps exactly that one
      utimesSync(
        lock(dir, touchedId),
        new Date(),
        new Date(Date.now() + 60_000),
      );
      watcher.sweep();
      expect(touched).toEqual([touchedId]);
      // a stable lock never re-bumps
      watcher.sweep();
      expect(touched).toEqual([touchedId]);

      // a lock appearing after the baseline is activity too (new thread)
      writeFileSync(lock(dir, "01a1cccc-1111-2222-3333-444444444444"), "");
      watcher.sweep();
      expect(touched).toEqual([
        touchedId,
        "01a1cccc-1111-2222-3333-444444444444",
      ]);

      // non-lock files are noise
      writeFileSync(join(dir, "notes.txt"), "");
      utimesSync(join(dir, "notes.txt"), new Date(), new Date());
      watcher.sweep();
      expect(touched).toEqual([
        touchedId,
        "01a1cccc-1111-2222-3333-444444444444",
      ]);

      // a deleted lock drops out of the baselines — reappearing re-bumps
      unlinkSync(lock(dir, quietId));
      watcher.sweep();
      expect(touched).toEqual([
        touchedId,
        "01a1cccc-1111-2222-3333-444444444444",
      ]);
      writeFileSync(lock(dir, quietId), "");
      watcher.sweep();
      expect(touched).toEqual([
        touchedId,
        "01a1cccc-1111-2222-3333-444444444444",
        quietId,
      ]);
    } finally {
      watcher.stop();
    }
  });

  test("a missing directory disables the watcher with one warning", () => {
    const warnings: string[] = [];
    const watcher = createCodexLockWatcher({
      store: { touchSession: async () => true },
      dir: join(tmpdir(), `slopwatch-nope-${crypto.randomUUID().slice(0, 8)}`),
      log: (message) => warnings.push(message),
    });
    expect(watcher.active).toBe(false);
    watcher.sweep(); // a no-op, never a throw
    watcher.stop();
    expect(warnings).toHaveLength(1);
  });

  test("a failed bump is logged, not thrown", async () => {
    const dir = makeLocksDir();
    writeFileSync(lock(dir, "01a1dddd-1111-2222-3333-444444444444"), "");
    const logged: unknown[] = [];
    const watcher = createCodexLockWatcher({
      store: {
        touchSession: async () => {
          throw new Error("db down");
        },
      },
      dir,
      pollMs: 3_600_000,
      log: (message, error) => logged.push([message, error]),
    });
    try {
      // the touch — the lock was already in the baseline, so the mtime
      // change is what triggers the (failing) bump
      utimesSync(
        lock(dir, "01a1dddd-1111-2222-3333-444444444444"),
        new Date(),
        new Date(Date.now() + 60_000),
      );
      watcher.sweep();
      // the bump is fire-and-forget — give the rejection a tick to land
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(logged).toHaveLength(1);
    } finally {
      watcher.stop();
    }
  });

  test("codexLocksDir: explicit env, CODEX_HOME, then the default home", () => {
    expect(codexLocksDir({ CODEX_LOCKS_DIR: "D:\\locks" })).toBe("D:\\locks");
    expect(codexLocksDir({ CODEX_HOME: "D:\\codex-home" })).toBe(
      join("D:\\codex-home", "thread-writer-locks"),
    );
    expect(codexLocksDir({})).toBe(
      join(homedir(), ".codex", "thread-writer-locks"),
    );
  });
});
