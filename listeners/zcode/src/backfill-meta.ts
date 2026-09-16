/**
 * Backfill session metadata (title + task preview) for an already-captured
 * session without re-sending its history: reads the rollout, emits ONLY
 * session:meta events. Idempotent on the server (meta upserts).
 *
 * Usage: bun backfill-meta.ts --file <rollout> --server-url U --token T
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { sendEvents, type SessionMetaEvent } from "@slopwatch/events";
import { argvHelpers } from "@slopwatch/listener-shared";
import {
  metaFromRecord,
  resolveSessionId,
  taskPreviewFromRecord,
} from "./normalizer";

const { arg } = argvHelpers(process.argv.slice(2));
const file = arg("file");
const serverUrl = arg("server-url");
const token = arg("token");
if (!file || !serverUrl || !token) {
  console.error(
    "usage: bun backfill-meta.ts --file <rollout> --server-url U --token T",
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

let sessionId: string | null = null;
for (const record of records) {
  sessionId = resolveSessionId(record, basename(file));
  if (sessionId) break;
}
if (!sessionId) {
  console.error("cannot resolve session id");
  process.exit(1);
}

const metas: SessionMetaEvent[] = [];
const title = records.map((r) => metaFromRecord(r, sessionId!)).find(Boolean);
if (title) metas.push(title);
const preview = records
  .map((r) => taskPreviewFromRecord(r, sessionId!))
  .find(Boolean);
if (preview) metas.push(preview);

if (metas.length === 0) {
  console.log("no metadata found in rollout — nothing to send");
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
