import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCursor, writeCursor } from "./cursor";

describe("capture cursor", () => {
  const dir = mkdtempSync(join(tmpdir(), "slopwatch-cursor-"));
  const file = join(dir, "zcode-sess_x.cursor");

  test("missing or empty cursor reads as 0", () => {
    expect(readCursor(join(dir, "nope.cursor"))).toBe(0);
    writeCursor(file, 0);
    expect(readCursor(file)).toBe(0);
  });

  test("round-trips an offset", () => {
    writeCursor(file, 12345);
    expect(readCursor(file)).toBe(12345);
  });

  test("garbage content reads as 0", () => {
    writeFileSync(file, "not-a-number");
    expect(readCursor(file)).toBe(0);
  });

  test("negative or non-finite offsets are clamped to 0 on write", () => {
    writeCursor(file, -5);
    expect(readCursor(file)).toBe(0);
    writeCursor(file, Number.NaN);
    expect(readCursor(file)).toBe(0);
  });

  test("a concurrent writer's in-flight temp file is not consumed", () => {
    const other = join(dir, "zcode-sess_y.cursor");
    writeCursor(other, 7);
    // the old shared temp name, caught mid-write by another process
    writeFileSync(`${other}.tmp`, "99999");
    writeCursor(other, 8);
    expect(readCursor(other)).toBe(8);
    expect(readFileSync(`${other}.tmp`, "utf8")).toBe("99999"); // untouched
  });

  test("cleanup", () => {
    rmSync(dir, { recursive: true, force: true });
  });
});
