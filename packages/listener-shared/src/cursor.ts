import { readFileSync, writeFileSync } from "node:fs";

/**
 * Byte offset of the last ingested capture read, persisted per session so a
 * respawned generation resumes where the previous one stopped (no duplicates).
 */
export const readCursor = (path: string): number => {
  try {
    const n = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
  } catch {
    return 0;
  }
};

export const writeCursor = (path: string, offset: number): void => {
  const n = Number.isFinite(offset) && offset >= 0 ? Math.trunc(offset) : 0;
  writeFileSync(path, String(n));
};
