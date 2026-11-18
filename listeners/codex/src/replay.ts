/**
 * Replay a Codex rollout file as one batch of normalized events (one-shot
 * backfill / acceptance check). Unlike the ZCode replay, session facts come
 * from the rollout itself: session_meta carries cwd and the git info, so
 * the session:start event is faithful.
 *
 * Usage: bun listeners/codex/src/replay.ts <rollout-file> [--state-dir D]
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { argvHelpers } from "@slopwatch/listener-shared";
import {
  envelope,
  isNonEmptyString,
  isObject,
  quarantineLine,
  type NormalEvent,
  type SessionEndEvent,
  type SessionStartEvent,
} from "@slopwatch/events";
import { createCodexAdapter } from "./adapter";
import { sessionIdFromFilename } from "./normalizer";

const { arg } = argvHelpers(process.argv.slice(2));
const file = process.argv[2];
if (!file) {
  console.error("usage: bun replay.ts <rollout-file> [--state-dir D]");
  process.exit(1);
}

const records: unknown[] = [];
const unparsable: string[] = [];
for (const line of readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  try {
    records.push(JSON.parse(line));
  } catch {
    unparsable.push(line);
  }
}

// session identity: the session_meta payload.id (thread uuid), falling back
// to the filename
let sessionId: string | null = null;
let metaCwd: string | null = null;
let gitRemote: string | undefined;
for (const record of records) {
  if (!isObject(record) || record.type !== "session_meta") continue;
  const payload = isObject(record.payload) ? record.payload : null;
  if (!payload) continue;
  if (isNonEmptyString(payload.id)) sessionId = payload.id;
  if (isNonEmptyString(payload.cwd)) metaCwd = payload.cwd;
  if (isObject(payload.git) && isNonEmptyString(payload.git.repository_url)) {
    gitRemote = payload.git.repository_url;
  }
  break; // the first record wins — later metas (there are none) would fork
}
sessionId ??= sessionIdFromFilename(file) ?? "unknown-session";

// replay must not touch the live state dir's sidecars — an isolated temp
// dir keeps the one-shot run side-effect free
const stateDir =
  arg("state-dir") ?? mkdtempSync(join(tmpdir(), "slopwatch-codex-replay-"));
const adapterApi = createCodexAdapter({
  primarySessionId: sessionId,
  stateDir,
});
const adapter = adapterApi.adapter;

const now = new Date().toISOString();
const sessionStart: SessionStartEvent = {
  ...envelope("codex", sessionId, now),
  kind: "session",
  event: "start",
  cwd: metaCwd ?? process.cwd(),
  hostname: hostname(),
  ...(gitRemote ? { git_remote: gitRemote } : {}),
};
const sessionEnd: SessionEndEvent = {
  ...envelope("codex", sessionId, now),
  kind: "session",
  event: "end",
  reason: "replay",
};

const events: NormalEvent[] = [sessionStart];
for (const line of unparsable) {
  events.push(
    quarantineLine({
      agent: "codex",
      session_id: sessionId,
      reason: "unparsable json",
      line,
    }),
  );
}
for (const record of records) {
  const drift = adapter.driftFromRecord(record);
  if (drift !== null) {
    events.push(
      quarantineLine({
        agent: "codex",
        session_id: sessionId,
        reason: drift,
        line: JSON.stringify(record),
      }),
    );
  }
  events.push(...adapter.eventsFromRecord(record, sessionId));
}
const open = adapter.onTeardown?.() ?? [];
events.push(...open);
events.push(sessionEnd);

for (const event of events) {
  console.log(JSON.stringify(event));
}
