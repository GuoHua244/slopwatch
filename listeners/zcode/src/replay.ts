/**
 * Replay a ZCode rollout file as one batch of normalized events (M2 minimal
 * usage check). Note: replay cannot know the session's original cwd, so the
 * session.start event carries this process's cwd.
 *
 * Usage: bun listeners/zcode/src/replay.ts <rollout-file>
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename } from "node:path";
import {
  SCHEMA_VERSION,
  type NormalEvent,
  type SessionEndEvent,
  type SessionStartEvent,
} from "@slopwatch/events";
import {
  eventsFromRecord,
  metaFromRecord,
  resolveSessionId,
  taskPreviewFromRecord,
} from "./normalizer";

const file = process.argv[2];
if (!file) {
  console.error("usage: bun replay.ts <rollout-file>");
  process.exit(1);
}

const records = readFileSync(file, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

let sessionId: string | null = null;
for (const record of records) {
  sessionId = resolveSessionId(record, basename(file));
  if (sessionId) break;
}
sessionId ??= "unknown-session";

let gitRemote: string | undefined;
try {
  const remote = execSync("git remote get-url origin", {
    encoding: "utf8",
  }).trim();
  if (remote) gitRemote = remote;
} catch {
  // not a git repo / no origin — optional field
}

const now = new Date().toISOString();
const sessionStart: SessionStartEvent = {
  schema_version: SCHEMA_VERSION,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: now,
  kind: "session",
  event: "start",
  cwd: process.cwd(),
  hostname: hostname(),
  git_remote: gitRemote,
};
const sessionEnd: SessionEndEvent = {
  schema_version: SCHEMA_VERSION,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: now,
  kind: "session",
  event: "end",
  reason: "replay",
};

const events: NormalEvent[] = [sessionStart];
let taskPreviewSent = false;
for (const record of records) {
  const meta = metaFromRecord(record, sessionId);
  if (meta) events.push(meta);
  if (!taskPreviewSent) {
    const preview = taskPreviewFromRecord(record, sessionId);
    if (preview) {
      events.push(preview);
      taskPreviewSent = true;
    }
  }
  events.push(...eventsFromRecord(record, sessionId));
}
events.push(sessionEnd);
console.log(JSON.stringify(events, null, 2));
