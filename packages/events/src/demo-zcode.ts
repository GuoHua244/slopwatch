/**
 * M1 demo (minimal usage check): prove the v0 schema fits real ZCode rollout
 * data. Provisional — M2 (listeners/zcode) owns the production normalizer.
 *
 * Usage: bun packages/events/src/demo-zcode.ts <rollout-jsonl-file>
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename } from "node:path";
import {
  isNormalEvent,
  SCHEMA_VERSION,
  type ModelRequestEvent,
  type NormalEvent,
  type SessionStartEvent,
} from "./index";

const file = process.argv[2];
if (!file) {
  console.error("usage: bun demo-zcode.ts <rollout-jsonl-file>");
  process.exit(1);
}

// Session id from the rollout filename: model-io-sess_<uuid>.jsonl
const sessionId =
  basename(file).match(/^model-io-sess_(.+)\.jsonl$/)?.[1] ?? "unknown-session";

const record = JSON.parse(
  readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.trim())!,
);

let gitRemote: string | undefined;
try {
  gitRemote = execSync("git remote get-url origin", {
    encoding: "utf8",
  }).trim();
} catch {
  // no origin remote — the field is optional
}

const events: NormalEvent[] = [
  {
    schema_version: SCHEMA_VERSION,
    agent: "zcode",
    session_id: sessionId,
    occurred_at: record.completedAt,
    kind: "session",
    event: "start",
    cwd: process.cwd(),
    hostname: hostname(),
    git_remote: gitRemote,
    raw: { source: "demo", filename: basename(file) },
  },
  {
    schema_version: SCHEMA_VERSION,
    agent: "zcode",
    session_id: sessionId,
    occurred_at: record.completedAt,
    kind: "model_request",
    request_id: record.requestId,
    provider: record.model.providerId,
    model: record.model.modelId,
    duration_ms: record.durationMs,
    attempt: record.attempt,
    raw: record,
  },
];

console.log(JSON.stringify(events, null, 2));
console.error(
  `isNormalEvent: session=${isNormalEvent(events[0])} model_request=${isNormalEvent(events[1])}`,
);
