/**
 * Disk-backed event queue for the Listener sidecars (v2 decision 21). When
 * the Server is unreachable, flushes append batches to a JSONL queue file
 * beside the sidecar's cursor; once the Server answers again, batches replay
 * oldest-first. The queue decouples capture from the agent's rollout file —
 * ZCode deletes rollouts after a session ends, so "exit and resume from the
 * cursor" loses everything when the outage outlives the file.
 *
 * Caps: batches older than maxAgeMs and the oldest batches beyond maxBytes
 * are dropped, and every drop is counted so the caller can report it to the
 * Server's health page (as a quarantine event) once connectivity returns.
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
import type { NormalEvent } from "@slopwatch/events";

export const DEFAULT_QUEUE_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
  /** Append a batch; prunes first. Returns how many events were dropped. */
  enqueue: (events: NormalEvent[]) => { droppedEvents: number };
  /**
   * Send queued batches oldest-first through `send`. Stops at the first
   * failure and leaves the rest on disk. Corrupt lines are skipped forever
   * (counted as dropped) — they can never be sent.
   */
  replay: (
    send: (events: NormalEvent[]) => Promise<void>,
  ) => Promise<{ sentEvents: number; droppedEvents: number }>;
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
      if (events.length === 0) return { droppedEvents: 0 };
      const { entries, corruptLines } = readEntries();
      let dropped = corruptLines === 0 ? 0 : corruptLines;
      const cutoff = nowMs() - maxAgeMs;
      const fresh = entries.filter((e) => {
        const ts = Date.parse(e.enqueued_at);
        if (Number.isFinite(ts) && ts >= cutoff) return true;
        dropped += e.events.length;
        return false;
      });
      const entry: QueueEntry = {
        enqueued_at: new Date(nowMs()).toISOString(),
        events,
      };
      let kept = fresh;
      const newLine = lineBytes(entry);
      while (kept.length > 0) {
        const total = kept.reduce((n, e) => n + lineBytes(e), 0) + newLine;
        if (total <= maxBytes) break;
        dropped += kept[0]!.events.length;
        kept = kept.slice(1);
      }
      if (kept.length !== entries.length || corruptLines > 0) rewrite(kept);
      mkdirSync(dirname(opts.file), { recursive: true });
      appendFileSync(opts.file, `${JSON.stringify(entry)}\n`);
      return { droppedEvents: dropped };
    },

    async replay(send) {
      const { entries, corruptLines } = readEntries();
      let sentEvents = 0;
      let consumed = 0;
      for (const entry of entries) {
        try {
          await send(entry.events);
        } catch {
          break; // server still unreachable — leave the rest on disk
        }
        consumed += 1;
        sentEvents += entry.events.length;
      }
      const droppedEvents = corruptLines;
      if (consumed > 0 || corruptLines > 0) {
        rewrite(entries.slice(consumed));
      }
      return { sentEvents, droppedEvents };
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
