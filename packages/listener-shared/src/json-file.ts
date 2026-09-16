import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write a JSON document atomically: the value lands via a temp file + rename,
 * so a crash mid-write cannot truncate the user's previous content. The
 * optional mode (e.g. 0o600) is applied when the temp file is created and
 * survives the rename — secrets never touch the disk world-readable.
 */
export const atomicWriteJson = (
  path: string,
  value: unknown,
  mode?: number,
): void => {
  // installing before the host's first run must not crash on a missing dir
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(tmp, path);
};

/**
 * The result of {@link readSettingsJson}: the parsed value (`undefined` when
 * the file does not exist yet — a fresh install), or not-ok when the file
 * exists but is not valid JSON.
 */
export type SettingsRead =
  | { ok: true; value: unknown }
  | { ok: true; value: undefined }
  | { ok: false };

/**
 * Read a host settings/config JSON file for merging: missing file →
 * `{ ok: true, value: undefined }`, corrupt file → `{ ok: false }` so the
 * caller can refuse to touch it (installers must never clobber a settings
 * file they cannot parse). Callers own the user-facing error text.
 */
export const readSettingsJson = (path: string): SettingsRead => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: true, value: undefined };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
};
