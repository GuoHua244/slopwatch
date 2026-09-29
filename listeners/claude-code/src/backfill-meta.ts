/**
 * Backfill session metadata (title + task preview) for an already-captured
 * session without re-sending its history: reads the transcript, emits ONLY
 * session:meta events. Idempotent on the server (meta upserts). The title
 * comes from an `ai-title` record (or the legacy `summary` record); the
 * preview from the first real user prompt — the same rules the live
 * normalizer applies.
 *
 * Usage: bun backfill-meta.ts --file <transcript> --server-url U --token T
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  envelope,
  isNonEmptyString,
  isObject,
  sendEvents,
  type SessionMetaEvent,
} from "@slopwatch/events";
import { argvHelpers } from "@slopwatch/listener-shared";
import {
  isRealPromptRecord,
  metaFromRecord,
  promptTextFromRecord,
} from "./normalizer";

const { arg } = argvHelpers(process.argv.slice(2));
const file = arg("file");
const serverUrl = arg("server-url");
const token = arg("token");
if (!file || !serverUrl || !token) {
  console.error(
    "usage: bun backfill-meta.ts --file <transcript> --server-url U --token T",
  );
  process.exit(1);
}

// one malformed line must not crash the whole tool — skip and count it
// (mirrors replay.ts)
const records: unknown[] = [];
let malformed = 0;
for (const line of readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  try {
    records.push(JSON.parse(line) as unknown);
  } catch {
    malformed += 1;
  }
}

const sessionIdFromRecords = (): string | null => {
  for (const record of records) {
    if (!isObject(record)) continue;
    for (const key of ["session_id", "sessionId"]) {
      if (isNonEmptyString(record[key])) return record[key];
    }
  }
  return null;
};
const sessionId = sessionIdFromRecords();
if (!sessionId) {
  console.error("cannot resolve session id");
  process.exit(1);
}

const metas: SessionMetaEvent[] = [];
const title = records.map((r) => metaFromRecord(r, sessionId)).find(Boolean);
if (title) metas.push(title);
const previewRecord = records.find((r) => isRealPromptRecord(r));
if (previewRecord) {
  const text = promptTextFromRecord(previewRecord);
  if (text) {
    const record = previewRecord as { timestamp?: unknown };
    const occurredAt = isNonEmptyString(record.timestamp)
      ? record.timestamp
      : new Date().toISOString();
    metas.push({
      ...envelope("claude-code", sessionId, occurredAt),
      kind: "session",
      event: "meta",
      task_preview: text.slice(0, 160),
    });
  }
}

if (metas.length === 0) {
  console.log("no metadata found in transcript — nothing to send");
  process.exit(0);
}
await sendEvents(metas, { serverUrl, token });
console.log(
  `sent ${metas.length} meta event(s) for ${sessionId}:`,
  metas
    .map((m) =>
      m.title ? `title="${m.title}"` : `task="${m.task_preview?.slice(0, 40)}"`,
    )
    .join(", "),
);
if (malformed > 0) {
  console.log(`skipped ${malformed} malformed lines`);
}
