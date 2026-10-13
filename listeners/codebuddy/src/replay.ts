/**
 * Replay one CodeBuddy conversation offline as a single batch of normalized
 * events (NDJSON on stdout). Used to backfill a session that ran before the
 * listener was installed — the history files are immutable and never pruned,
 * so a conversation can be replayed days later, and its token counts are read
 * from whatever agent log still exists for that day.
 *
 * Usage: bun replay.ts --transcript-path <index.json> [--usage-log <file.log>]
 *        bun replay.ts --cwd <workspace> [--conversation <id>]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  envelope,
  type NormalEvent,
  type SessionEndEvent,
  type SessionStartEvent,
} from "@slopwatch/events";
import {
  createSummaryFolder,
  createTurnDigest,
} from "@slopwatch/listener-shared";
import { AGENT, newTailState, normalizeMessage } from "./normalizer";
import {
  conversationIndexPath,
  latestConversation,
  messagePath,
  resolveSurfaces,
  workspaceHash,
  workspaceIndexPath,
  type ConversationRef,
} from "./paths";
import {
  conversationTitle,
  newIndexMessages,
  parseConversationIndex,
  parseMessageFile,
  parseWorkspaceIndex,
} from "./transcript";
import { indexUsageByMessage, usageFromLogText } from "./usage";

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const surfaces = arg("transcript-path")
  ? resolveSurfaces({ transcriptPath: arg("transcript-path") })
  : null;
const cwd = arg("cwd") ?? process.cwd();
const hash = workspaceHash(cwd);

const ref: ConversationRef =
  surfaces?.ref ??
  ((): ConversationRef => {
    const wanted = arg("conversation");
    if (wanted)
      return {
        root:
          latestConversation(process.env.LOCALAPPDATA ?? "", hash)?.root ?? "",
        workspaceHash: hash,
        conversationId: wanted,
      };
    const found = latestConversation(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      hash,
    );
    if (!found) {
      console.error(`replay: no CodeBuddy conversation found in ${cwd}`);
      process.exit(1);
    }
    return found;
  })();

const sessionId = ref.conversationId;
const usageLog = arg("usage-log") ?? surfaces?.usageLog ?? null;

if (!arg("transcript-path") && !arg("cwd")) {
  console.error(
    "usage: bun replay.ts --transcript-path <history index.json> [--usage-log <file.log>]",
  );
  process.exit(1);
}

let gitRemote: string | undefined;
try {
  const remote = execSync("git remote get-url origin", {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  if (remote) gitRemote = remote;
} catch {
  // not a git repo / no origin — optional field
}

const usageByMessage = usageLog
  ? (() => {
      try {
        return indexUsageByMessage(
          usageFromLogText(readFileSync(usageLog, "utf8")),
        );
      } catch {
        return new Map();
      }
    })()
  : new Map();

// throwaway state dir: replay must not touch the live listener's sidecars
const stateBase = mkdtempSync(join(tmpdir(), "slopwatch-replay-"));
const folder = createSummaryFolder({ agent: AGENT, sessionId, stateBase });
const digest = createTurnDigest(folder.digests);

const start: SessionStartEvent = {
  ...envelope(AGENT, sessionId, new Date().toISOString()),
  kind: "session",
  event: "start",
  cwd,
  hostname: "replay",
  ...(gitRemote ? { git_remote: gitRemote } : {}),
};

const batch: NormalEvent[] = [start];

const indexText = readFileSync(conversationIndexPath(ref), "utf8");
const index = parseConversationIndex(indexText);
if (!index.ok) {
  console.error(`replay: ${index.reason}`);
  process.exit(1);
}

const state = newTailState();
for (const row of newIndexMessages(index.value, 0)) {
  let raw: string;
  try {
    raw = readFileSync(messagePath(ref, row.id), "utf8");
  } catch {
    continue; // the message file for this row is gone — nothing to replay
  }
  const parsed = parseMessageFile(raw);
  if (!parsed.ok) {
    console.error(`replay: skipped ${row.id} (${parsed.reason})`);
    continue;
  }
  batch.push(
    ...normalizeMessage({
      message: parsed.message,
      sessionId,
      state,
      usage: usageByMessage.get(row.id) ?? null,
    }),
  );
}

// the workspace index carries the title the live path would have shipped
const workspaceIndex = (() => {
  try {
    return parseWorkspaceIndex(readFileSync(workspaceIndexPath(ref), "utf8"));
  } catch {
    return null;
  }
})();
const title = conversationTitle(workspaceIndex, ref.conversationId);
if (title) {
  batch.push({
    ...envelope(AGENT, sessionId, new Date().toISOString()),
    kind: "session",
    event: "meta",
    title: title.slice(0, 200),
  });
}

digest.observe(batch);
digest.close();
const end: SessionEndEvent = {
  ...envelope(AGENT, sessionId, new Date().toISOString()),
  kind: "session",
  event: "end",
  reason: "replay",
};
batch.push(end);

for (const event of batch) console.log(JSON.stringify(event));
console.error(`replay: ${batch.length} events for ${sessionId}`);
