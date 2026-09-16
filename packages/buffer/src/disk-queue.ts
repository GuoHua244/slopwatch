/**
 * Disk-backed event queue for the per-session listeners (v2 decision 21). When
 * the Server is unreachable, flushes append batches to a JSONL queue file
 * beside the listener's cursor; once the Server answers again, batches replay
 * oldest-first. The queue decouples capture from the agent's rollout file —
 * ZCode deletes rollouts after a session ends, so "exit and resume from the
 * cursor" loses everything when the outage outlives the file.
 *
 * Caps: batches older than maxAgeMs and the oldest batches beyond maxBytes
 * are dropped, and every drop is counted with a reason (age-expired,
 * byte-cap, oversized-batch, poison-batch, corrupt-line) so the caller can
 * report it to the Server's health page (as a quarantine event) once
 * connectivity returns.
 * A batch the Server permanently rejects (HTTP 4xx, e.g. validation drift
 * after an upgrade) is dropped-and-counted too, so it cannot squat on the
 * queue head forever — only transient failures hold the line.
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { SendError, type NormalEvent } from "@slopwatch/events";

export const DEFAULT_QUEUE_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Why the queue discarded events. The flusher reports the breakdown to the
 * Server's health page inside its buffer-overflow quarantine line.
 */
export type DropReason =
  | "age-expired" // entry older than maxAgeMs
  | "byte-cap" // oldest entries evicted to admit a new batch
  | "oversized-batch" // a single batch larger than the whole byte cap
  | "poison-batch" // the server permanently rejected it (HTTP 4xx)
  | "corrupt-line"; // unparsable queue line (e.g. a torn write)

export type DropCounts = Partial<Record<DropReason, number>>;

export type EnqueueResult = {
  droppedEvents: number;
  droppedReasons: DropCounts;
};

export type ReplayResult = {
  sentEvents: number;
  droppedEvents: number;
  droppedReasons: DropCounts;
};

/**
 * True when re-sending can never succeed: the server understood the batch and
 * refused it (validation, oversize). Timeouts and 408/429 stay transient —
 * they mean "later", not "never".
 */
export const isPermanentRejection = (e: unknown): boolean =>
  e instanceof SendError &&
  e.status >= 400 &&
  e.status < 500 &&
  e.status !== 408 &&
  e.status !== 429;

export type QueueStats = {
  entries: number;
  events: number;
  bytes: number;
};

type QueueEntry = {
  enqueued_at: string;
  events: NormalEvent[];
};

export type DiskQueue = {
  /** Append a batch; prunes first. Returns how many events were dropped, and why. */
  enqueue: (events: NormalEvent[]) => EnqueueResult;
  /**
   * Send queued batches oldest-first through `send`. Stops at the first
   * transient failure and leaves the rest on disk; a batch the server
   * permanently rejects (4xx) is dropped — counted — and the queue keeps
   * flowing. Corrupt lines are skipped forever (counted as dropped) — they
   * can never be sent.
   */
  replay: (
    send: (events: NormalEvent[]) => Promise<void>,
  ) => Promise<ReplayResult>;
  stats: () => QueueStats;
};

const lineBytes = (entry: QueueEntry): number =>
  Buffer.byteLength(`${JSON.stringify(entry)}\n`, "utf8");

export const createDiskQueue = (opts: {
  file: string;
  maxBytes?: number;
  maxAgeMs?: number;
  now?: () => number;
}): DiskQueue => {
  const maxBytes = opts.maxBytes ?? DEFAULT_QUEUE_MAX_BYTES;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_QUEUE_MAX_AGE_MS;
  const nowMs = opts.now ?? (() => Date.now());

  const readEntries = (): {
    entries: QueueEntry[];
    corruptLines: number;
  } => {
    if (!existsSync(opts.file)) return { entries: [], corruptLines: 0 };
    const entries: QueueEntry[] = [];
    let corruptLines = 0;
    for (const line of readFileSync(opts.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as QueueEntry;
        if (
          typeof parsed.enqueued_at !== "string" ||
          !Array.isArray(parsed.events)
        ) {
          corruptLines += 1;
          continue;
        }
        entries.push(parsed);
      } catch {
        corruptLines += 1;
      }
    }
    return { entries, corruptLines };
  };

  // Atomic rewrite: write a temp file next to the queue, rename over it.
  const rewrite = (entries: QueueEntry[]): void => {
    const tmp = `${opts.file}.tmp`;
    mkdirSync(dirname(opts.file), { recursive: true });
    writeFileSync(
      tmp,
      entries.map((e) => JSON.stringify(e)).join("\n") +
        (entries.length > 0 ? "\n" : ""),
    );
    renameSync(tmp, opts.file);
  };

  const queue: DiskQueue = {
    enqueue(events) {
      if (events.length === 0) {
        return { droppedEvents: 0, droppedReasons: {} };
      }
      const { entries, corruptLines } = readEntries();
      const reasons: DropCounts = {};
      const drop = (reason: DropReason, count: number): void => {
        reasons[reason] = (reasons[reason] ?? 0) + count;
      };
      let dropped = corruptLines;
      if (corruptLines > 0) drop("corrupt-line", corruptLines);
      const cutoff = nowMs() - maxAgeMs;
      const fresh = entries.filter((e) => {
        const ts = Date.parse(e.enqueued_at);
        if (Number.isFinite(ts) && ts >= cutoff) return true;
        dropped += e.events.length;
        drop("age-expired", e.events.length);
        return false;
      });
      const entry: QueueEntry = {
        enqueued_at: new Date(nowMs()).toISOString(),
        events,
      };
      const newLine = lineBytes(entry);
      if (newLine > maxBytes) {
        // A single batch larger than the whole cap can never fit — count it
        // as dropped instead of evicting every older batch to admit it.
        dropped += events.length;
        drop("oversized-batch", events.length);
        if (fresh.length !== entries.length || corruptLines > 0) rewrite(fresh);
        return { droppedEvents: dropped, droppedReasons: reasons };
      }
      let kept = fresh;
      while (kept.length > 0) {
        const total = kept.reduce((n, e) => n + lineBytes(e), 0) + newLine;
        if (total <= maxBytes) break;
        dropped += kept[0]!.events.length;
        drop("byte-cap", kept[0]!.events.length);
        kept = kept.slice(1);
      }
      if (kept.length !== entries.length || corruptLines > 0) rewrite(kept);
      mkdirSync(dirname(opts.file), { recursive: true });
      appendFileSync(opts.file, `${JSON.stringify(entry)}\n`);
      return { droppedEvents: dropped, droppedReasons: reasons };
    },

    async replay(send) {
      const { entries, corruptLines } = readEntries();
      let sentEvents = 0;
      let droppedEvents = corruptLines;
      const reasons: DropCounts =
        corruptLines > 0 ? { "corrupt-line": corruptLines } : {};
      let consumed = 0;
      for (const entry of entries) {
        try {
          await send(entry.events);
        } catch (e) {
          if (isPermanentRejection(e)) {
            // The server will refuse this batch on every retry (validation
            // drift, oversize) — drop it and keep the queue flowing instead
            // of letting a poison head block everything behind it.
            droppedEvents += entry.events.length;
            reasons["poison-batch"] =
              (reasons["poison-batch"] ?? 0) + entry.events.length;
            consumed += 1;
            continue;
          }
          break; // server still unreachable — leave the rest on disk
        }
        consumed += 1;
        sentEvents += entry.events.length;
      }
      if (consumed > 0 || corruptLines > 0) {
        rewrite(entries.slice(consumed));
      }
      return { sentEvents, droppedEvents, droppedReasons: reasons };
    },

    stats() {
      const { entries } = readEntries();
      return {
        entries: entries.length,
        events: entries.reduce((n, e) => n + e.events.length, 0),
        bytes: existsSync(opts.file) ? statSync(opts.file).size : 0,
      };
    },
  };
  return queue;
};
