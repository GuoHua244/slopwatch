/**
 * Where CodeBuddy keeps its world — the one module that knows the host's
 * layout, so the rest of the listener deals in typed surfaces.
 *
 * Measured 2026-10-08 on Windows (research/codebuddy-capture-surfaces.md);
 * none of this is documented by the vendor, everything here is pinned against
 * a real install:
 *
 * - transcripts live under
 *   `<LOCALAPPDATA>/CodeBuddyExtension/Data/<instance>/CodeBuddyIDE/<instance>/history/<ws-hash>/<conversation-id>/`
 *   as ONE FILE PER MESSAGE plus a rewritten `index.json`, never as JSONL;
 * - `<ws-hash>` is md5 of the lower-cased Windows workspace path — proven by
 *   an exact match, so a known cwd addresses a workspace directly;
 * - token counts are not in the transcript at all — they ride the per-day
 *   agent log `<LOCALAPPDATA>/CodeBuddyExtension/Logs/CodeBuddyIDE/<date>/<name>__<ws-hash>.log`;
 * - the hook payload's `cwd` is the *editor install directory* and must never
 *   be trusted as the session's cwd; the reverse map below replaces it.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

/** Candidate product directories under `%APPDATA%` (CN build first). */
export const APPDATA_DIRS = ["CodeBuddy CN", "CodeBuddy"] as const;

/** Candidate product directories under `%LOCALAPPDATA%`. */
export const LOCALAPPDATA_DIRS = ["CodeBuddyExtension"] as const;

export type HostRoots = {
  /** Where session data is written (CodeBuddyExtension's Data dir). */
  localAppData: string;
  /** Where the IDE records its workspaces (settings Storage). */
  appData: string;
};

export const defaultHostRoots = (): HostRoots => ({
  localAppData: process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
  appData: process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
});

/**
 * The workspace's address form inside CodeBuddy's history tree: the
 * back-slash-separated absolute path WITHOUT a trailing separator, with only
 * the drive letter lower-cased (directory case is preserved — the recorded
 * hash is md5 of `d:\studySpace\slopwatch`, not of a fully lower-cased path,
 * which a round of alphabet-soup md5 comparisons ruled out against real
 * directory names).
 */
export const windowsKey = (path: string): string => {
  // Pure string normalization, deliberately not the running platform's
  // resolve(): the key names a Windows path on every host — a posix
  // resolve() would silently prefix a Linux cwd onto "d:\..." and change
  // the hash under non-Windows tests.
  const normalized = path.replaceAll("/", "\\");
  const trimmed = normalized.replace(/\\+$/, "");
  const drive = trimmed.match(/^([A-Za-z]):/);
  return drive ? `${drive[1]!.toLowerCase()}${trimmed.slice(1)}` : trimmed;
};

export const workspaceHash = (cwd: string): string =>
  createHash("md5").update(windowsKey(cwd), "utf8").digest("hex");

/**
 * CodeBuddy's own workspace record: `<storage>/workspace.json` carries the
 * folder URI, so a workspace hash can be turned back into a real path
 * authoritatively instead of guessed at. Without it, the only honest answer
 * for an unknown hash is "unknown".
 */
export const workspaceMap = (appData: string): Map<string, string> => {
  const map = new Map<string, string>();
  for (const product of APPDATA_DIRS) {
    const storage = join(appData, product, "User", "workspaceStorage");
    let ids: string[];
    try {
      ids = readdirSync(storage);
    } catch {
      continue;
    }
    for (const id of ids) {
      let text: string;
      try {
        text = readFileSync(join(storage, id, "workspace.json"), "utf8");
      } catch {
        continue; // no workspace.json — not a folder workspace
      }
      const folder = parseFolderUri(text);
      if (!folder) continue;
      map.set(workspaceHash(folder), folder);
    }
  }
  return map;
};

const parseFolderUri = (text: string): string | null => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const folder = (value as { folder?: unknown }).folder;
  if (typeof folder !== "string" || !folder.startsWith("file:///")) return null;
  // file:///d%3A/studySpace/slopwatch → d:\studySpace\slopwatch
  const raw = decodeURIComponent(folder.slice("file:///".length));
  const drive = raw.match(/^\/([A-Za-z]:)(?:\/|$)/);
  if (!drive) return windowsPath(raw);
  return windowsPath(`${drive[1]}${raw.slice(drive[0].length - 1)}`);
};

const windowsPath = (p: string): string =>
  p.replaceAll("/", "\\").replace(/^\\+([A-Za-z]:)/, "$1");

export const cwdForHash = (
  map: Map<string, string>,
  hash: string,
): string | null => map.get(hash.toLowerCase()) ?? null;

/**
 * The history roots CodeBuddy has written so far — one per app instance, each
 * containing `history/<ws-hash>/<conversation-id>/`.
 */
export const historyRoots = (localAppData: string): string[] => {
  const found: string[] = [];
  for (const product of LOCALAPPDATA_DIRS) {
    const base = join(localAppData, product, "Data");
    let instances: string[];
    try {
      instances = readdirSync(base);
    } catch {
      continue;
    }
    for (const instance of instances) {
      const candidate = join(base, instance, "CodeBuddyIDE", instance);
      if (existsSync(join(candidate, "history"))) found.push(candidate);
    }
  }
  return found;
};

export type ConversationRef = {
  /** Root that contains `history/`, `file-tree/`, `plan-task/`. */
  root: string;
  /** md5 of the lower-cased Windows workspace path. */
  workspaceHash: string;
  /** The hook payload's `session_id`. */
  conversationId: string;
};

/** Split a hook `transcript_path` back into its three coordinates. */
export const conversationFromTranscriptPath = (
  transcriptPath: string,
): ConversationRef | null => {
  const parts = transcriptPath.replaceAll("\\", "/").split("/");
  const index = parts.indexOf("history");
  if (index < 0 || index + 2 >= parts.length) return null;
  const conversationId = parts[index + 2];
  if (!conversationId) return null;
  return {
    root: parts.slice(0, index).join(sep),
    workspaceHash: parts[index + 1] ?? "",
    conversationId,
  };
};

export const conversationDir = (ref: ConversationRef): string =>
  join(ref.root, "history", ref.workspaceHash, ref.conversationId);

export const conversationIndexPath = (ref: ConversationRef): string =>
  join(conversationDir(ref), "index.json");

export const messagesDir = (ref: ConversationRef): string =>
  join(conversationDir(ref), "messages");

export const messagePath = (ref: ConversationRef, messageId: string): string =>
  join(messagesDir(ref), `${messageId}.json`);

/** `<root>/history/<ws-hash>/index.json` — every conversation of a workspace. */
export const workspaceIndexPath = (ref: ConversationRef): string =>
  join(ref.root, "history", ref.workspaceHash, "index.json");

/**
 * The agent log carrying token usage for this workspace and day, named
 * `<workspace-name>__<ws-hash>.log` — resolved by suffix because the leading
 * workspace name is the folder's basename and is not ours to reconstruct.
 */
export const usageLogPath = (opts: {
  localAppData: string;
  workspaceHash: string;
  /** Defaults to today. The log rotates at midnight. */
  date?: Date;
}): string | null => {
  const date = opts.date ?? new Date();
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const suffix = `__${opts.workspaceHash.toLowerCase()}.log`;
  for (const product of LOCALAPPDATA_DIRS) {
    const dir = join(opts.localAppData, product, "Logs", "CodeBuddyIDE", stamp);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const hit = names.find((n) => n.toLowerCase().endsWith(suffix));
    if (hit) return join(dir, hit);
  }
  return null;
};

/**
 * Everything the listener needs about one conversation. `transcriptPath` from
 * a hook is authoritative when present; otherwise the machine is searched by
 * workspace hash (which is how a conversation that started before the
 * listener was installed is still found).
 */
export const resolveSurfaces = (opts: {
  transcriptPath?: string;
  cwd?: string;
  roots?: HostRoots;
  date?: Date;
}): {
  ref: ConversationRef;
  cwd: string;
  usageLog: string | null;
} | null => {
  const roots = opts.roots ?? defaultHostRoots();
  const fromHook = opts.transcriptPath
    ? conversationFromTranscriptPath(opts.transcriptPath)
    : null;
  const hash =
    fromHook?.workspaceHash ?? (opts.cwd ? workspaceHash(opts.cwd) : "");
  const reverse = workspaceMap(roots.appData);
  const cwd = cwdForHash(reverse, hash) ?? opts.cwd ?? "";
  if (fromHook) {
    return {
      ref: fromHook,
      cwd,
      usageLog: usageLogPath({
        localAppData: roots.localAppData,
        workspaceHash: fromHook.workspaceHash,
        date: opts.date,
      }),
    };
  }
  if (!opts.cwd) return null;
  // Discovery without a hook: the most recently written conversation of this
  // workspace is the one that is running (CodeBuddy appends to its index on
  // every step, so mtime is the cheap and honest ordering).
  const latest = latestConversation(roots.localAppData, hash);
  if (!latest) return null;
  return {
    ref: latest,
    cwd,
    usageLog: usageLogPath({
      localAppData: roots.localAppData,
      workspaceHash: hash,
      date: opts.date,
    }),
  };
};

export const latestConversation = (
  localAppData: string,
  hash: string,
): ConversationRef | null => {
  let best: { mtimeMs: number; ref: ConversationRef } | null = null;
  for (const root of historyRoots(localAppData)) {
    const wsDir = join(root, "history", hash);
    let ids: string[];
    try {
      ids = readdirSync(wsDir);
    } catch {
      continue;
    }
    for (const conversationId of ids) {
      const indexPath = join(wsDir, conversationId, "index.json");
      let mtimeMs: number;
      try {
        mtimeMs = statSync(indexPath).mtimeMs;
      } catch {
        continue;
      }
      if (!best || mtimeMs > best.mtimeMs)
        best = { mtimeMs, ref: { root, workspaceHash: hash, conversationId } };
    }
  }
  return best?.ref ?? null;
};
