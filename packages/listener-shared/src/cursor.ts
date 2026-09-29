import { readFileSync, renameSync, writeFileSync } from "node:fs";

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
  // Temp+rename, never an in-place write: a crash mid-write must not leave a
  // truncated cursor that reads back as 0 and re-tails the whole capture
  // file (the server has no dedup, so that double-counts everything).
  // The temp name is per-process (writes in one process are synchronous, so
  // the pid is enough): a respawn racing its dying predecessor for the same
  // cursor must not share one temp path and publish half-written bytes.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, String(n));
  renameSync(tmp, path);
};
