/**
 * Per-session rolling-summary state, persisted next to the listener's cursor
 * (same state-file base, distinct suffixes): `<base>.summary.json` keeps the
 * last summary text plus how many digest entries it has folded in;
 * `<base>.digest.jsonl` is the log of not-yet-folded turn digests. Anything
 * missing or corrupt loads as empty — summaries must never break capture.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type SummaryCache = {
  /** Rolling summary text covering the whole session so far. */
  body: string;
  /** Model that produced it. */
  model: string;
  /** Cumulative count of digest entries already folded into `body`. */
  folded: number;
  updatedAt: string;
};

export type SummaryStore = {
  paths: { cache: string; digests: string };
  loadCache: () => SummaryCache | null;
  saveCache: (cache: SummaryCache) => void;
  appendDigest: (text: string) => void;
  pendingDigests: () => string[];
  clearDigests: () => void;
};

const isValidCache = (v: unknown): v is SummaryCache =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as SummaryCache).body === "string" &&
  (v as SummaryCache).body.length > 0 &&
  typeof (v as SummaryCache).model === "string" &&
  Number.isInteger((v as SummaryCache).folded) &&
  (v as SummaryCache).folded >= 0 &&
  typeof (v as SummaryCache).updatedAt === "string";

export const summaryStore = (stateBase: string): SummaryStore => {
  const paths = {
    cache: `${stateBase}.summary.json`,
    digests: `${stateBase}.digest.jsonl`,
  };

  const loadCache = (): SummaryCache | null => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(paths.cache, "utf8"));
      return isValidCache(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const saveCache = (cache: SummaryCache): void => {
    mkdirSync(dirname(paths.cache), { recursive: true });
    writeFileSync(paths.cache, JSON.stringify(cache, null, 2) + "\n");
  };

  const appendDigest = (text: string): void => {
    mkdirSync(dirname(paths.digests), { recursive: true });
    writeFileSync(paths.digests, `${JSON.stringify(text)}\n`, { flag: "a" });
  };

  const pendingDigests = (): string[] => {
    let raw: string;
    try {
      raw = readFileSync(paths.digests, "utf8");
    } catch {
      return [];
    }
    const texts: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === "string") texts.push(parsed);
      } catch {
        // skip a torn trailing line — the next append rewrites cleanly
      }
    }
    return texts;
  };

  const clearDigests = (): void => {
    rmSync(paths.digests, { force: true });
  };

  return {
    paths,
    loadCache,
    saveCache,
    appendDigest,
    pendingDigests,
    clearDigests,
  };
};
