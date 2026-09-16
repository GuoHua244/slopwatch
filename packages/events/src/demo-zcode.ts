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

const lines = readFileSync(file, "utf8")
  .split("\n")
  .filter((line) => line.trim());
if (lines.length === 0) {
  console.error(`no records in rollout file: ${file}`);
  process.exit(1);
}

type RolloutRecord = {
  completedAt?: unknown;
  requestId?: unknown;
  durationMs?: unknown;
  attempt?: unknown;
  model?: { providerId?: unknown; modelId?: unknown };
};
const record = JSON.parse(lines[0]!) as RolloutRecord;
if (
  typeof record.completedAt !== "string" ||
  typeof record.model?.providerId !== "string" ||
  typeof record.model?.modelId !== "string"
) {
  console.error("record missing completedAt/model");
  process.exit(1);
}

let gitRemote: string | undefined;
try {
  gitRemote = execSync("git remote get-url origin", {
    encoding: "utf8",
  }).trim();
} catch {
  // no origin remote — the field is optional
}

// the guard above proves completedAt/providerId/modelId are strings; the
// numeric fields ride through as-is — the isNormalEvent check below reports
// any remaining drift (that report is the point of this demo)
const occurredAt = record.completedAt as string;
const events: NormalEvent[] = [
  {
    schema_version: SCHEMA_VERSION,
    agent: "zcode",
    session_id: sessionId,
    occurred_at: occurredAt,
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
    occurred_at: occurredAt,
    kind: "model_request",
    request_id: record.requestId as string | undefined,
    provider: record.model!.providerId as string,
    model: record.model!.modelId as string,
    duration_ms: record.durationMs as number,
    attempt: record.attempt as number | undefined,
    raw: record,
  },
];

console.log(JSON.stringify(events, null, 2));
console.error(
  `isNormalEvent: session=${isNormalEvent(events[0])} model_request=${isNormalEvent(events[1])}`,
);
