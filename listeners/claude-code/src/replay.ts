/**
 * Replay a Claude Code transcript as one batch of normalized events (M2
 * minimal usage check). Note: replay cannot know the session's original cwd,
 * so the session.start event carries this process's cwd. Subagent child
 * transcripts (`subagents/agent-*.jsonl`) can be replayed individually —
 * they replay as their own session.
 *
 * Usage: bun listeners/claude-code/src/replay.ts <transcript-file>
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  envelope,
  isNonEmptyString,
  isObject,
  quarantineLine,
  type NormalEvent,
  type SessionEndEvent,
  type SessionStartEvent,
} from "@slopwatch/events";
import { createClaudeCodeAdapter } from "./adapter";
import { driftFromRecord } from "./normalizer";

const file = process.argv[2];
if (!file) {
  console.error("usage: bun replay.ts <transcript-file>");
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

const sessionIdFromRecords = (): string | null => {
  for (const record of records) {
    if (!isObject(record)) continue;
    for (const key of ["session_id", "sessionId"]) {
      if (isNonEmptyString(record[key])) return record[key];
    }
  }
  return null;
};
const sessionId =
  sessionIdFromRecords() ?? basename(file).replace(/\.jsonl$/, "");

let gitRemote: string | undefined;
try {
  const remote = execSync("git remote get-url origin", {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  if (remote) gitRemote = remote;
} catch {
  // not a git repo / no origin — optional field
}

// throwaway state dir: replay must not touch the live listener's sidecars
const stateDir = mkdtempSync(join(tmpdir(), "slopwatch-replay-"));
const adapterApi = createClaudeCodeAdapter({
  primarySessionId: sessionId,
  stateDir,
});
const { adapter } = adapterApi;

const start: SessionStartEvent = {
  ...envelope("claude-code", sessionId, new Date().toISOString()),
  kind: "session",
  event: "start",
  cwd: process.cwd(),
  hostname: hostname(),
  ...(gitRemote ? { git_remote: gitRemote } : {}),
};

const batch: NormalEvent[] = [start];
for (const record of records) {
  const drift = driftFromRecord(record);
  if (drift !== null) {
    batch.push(
      quarantineLine({
        agent: "claude-code",
        session_id: sessionId,
        reason: drift,
        line: JSON.stringify(record),
      }),
    );
  }
  batch.push(...adapter.eventsFromRecord(record, sessionId));
}
batch.push(...adapter.onTeardown!());
const end: SessionEndEvent = {
  ...envelope("claude-code", sessionId, new Date().toISOString()),
  kind: "session",
  event: "end",
  reason: "replay",
};
batch.push(end);

for (const line of unparsable) {
  batch.push(
    quarantineLine({
      agent: "claude-code",
      session_id: sessionId,
      reason: "unparsable json",
      line,
    }),
  );
}

for (const event of batch) {
  console.log(JSON.stringify(event));
}
console.error(`replay: ${batch.length} events for ${sessionId}`);
