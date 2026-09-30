import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson } from "./json-file";

describe("atomicWriteJson", () => {
  test("round-trips a value and creates the parent directory", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "slopwatch-json-")),
      "nested",
      "sidecar.json",
    );
    atomicWriteJson(path, { a: 1 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ a: 1 });
  });

  test("a concurrent writer's in-flight temp file is neither consumed nor clobbered", () => {
    const dir = mkdtempSync(join(tmpdir(), "slopwatch-json-"));
    const path = join(dir, "sidecar.json");
    // the old shared temp name, caught mid-write by another process
    writeFileSync(`${path}.tmp`, '{"partial":');
    atomicWriteJson(path, { ok: true });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ok: true });
    expect(readFileSync(`${path}.tmp`, "utf8")).toBe('{"partial":');
  });

  test("the per-process temp file does not survive the rename", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "slopwatch-json-")),
      "sidecar.json",
    );
    atomicWriteJson(path, { ok: true });
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  });
});
