/**
 * Fixtures shaped like Claude Code transcript records
 * (`~/.claude/projects/<hash>/<session-uuid>.jsonl`). The schema is
 * undocumented — these are pinned against real machine captures
 * (2026-09-29, Claude Code 2.1.227–2.1.284). Key real-world facts they
 * encode:
 * - one model request = one assistant `message.id`, appended as ONE RECORD
 *   PER CONTENT BLOCK (thinking / text / one per tool_use), the full-message
 *   usage repeated on every record;
 * - `tool_result` user records interleave BETWEEN a message's own records
 *   (tools stream while the message is still being appended);
 * - titles ride `ai-title` records (the legacy `summary` record is gone);
 * - local-command echoes (`<command-name>` / `<local-command-`) are plain
 *   user records — only `origin.kind === "human"` (new builds) or the
 *   absence of command tags (old builds) marks a real prompt;
 * - subagent traffic carries `isSidechain: true` (inline on old builds, and
 *   in every record of a `subagents/agent-*.jsonl` child transcript).
 */

const SESSION = "3f1d9c2e-1111-4bbb-9c2e-000000000001";

const baseFields = {
  sessionId: SESSION,
  session_id: SESSION,
  isSidechain: false,
  userType: "external",
  cwd: "D:\\repo",
  gitBranch: "main",
  version: "2.1.284",
};

/** A real user prompt (origin.kind === "human" marks typed input on new builds). */
export const promptRecord = {
  parentUuid: null,
  uuid: "u-0001",
  timestamp: "2026-09-29T09:00:00.000Z",
  type: "user",
  origin: { kind: "human" },
  promptSource: "typed",
  message: { role: "user", content: "帮我看看这个仓库的结构" },
  ...baseFields,
};

/** A local-command echo — plain user record, NOT a real prompt. */
export const commandEchoRecord = {
  parentUuid: null,
  uuid: "u-0002",
  timestamp: "2026-09-29T09:00:05.000Z",
  type: "user",
  message: {
    role: "user",
    content:
      "<command-name>/clear</command-name>\n<command-message>clear</command-message>",
  },
  ...baseFields,
};

/** A task-notification user record — background noise, not a real prompt. */
export const taskNotificationRecord = {
  parentUuid: null,
  uuid: "u-0003",
  timestamp: "2026-09-29T09:00:06.000Z",
  type: "user",
  origin: { kind: "task-notification" },
  promptSource: "system",
  message: {
    role: "user",
    content: "<task-notification>background task finished</task-notification>",
  },
  ...baseFields,
};

/** A legacy prompt (old build): no origin field, decides by text alone. */
export const legacyPromptRecord = {
  parentUuid: null,
  uuid: "u-0004",
  timestamp: "2026-09-29T09:00:07.000Z",
  type: "user",
  message: { role: "user", content: "旧版本没有 origin 字段的真实提问" },
  version: "2.1.227",
  sessionId: SESSION,
  session_id: SESSION,
  isSidechain: false,
  userType: "external",
};

/** System-injected context (`isMeta`) — never a prompt. */
export const metaPromptRecord = {
  parentUuid: null,
  uuid: "u-0005",
  timestamp: "2026-09-29T09:00:08.000Z",
  type: "user",
  isMeta: true,
  message: {
    role: "user",
    content: "<system-reminder>injected</system-reminder>",
  },
  ...baseFields,
};

/**
 * One model request streamed as three records (thinking / text / tool_use),
 * all sharing message.id `msg_01XYZ`. Usage repeats identically on each.
 */
export const MSG_ID = "msg_01XYZ";

const messageBase = {
  id: MSG_ID,
  model: "claude-sonnet-4-5",
  role: "assistant",
  usage: {
    input_tokens: 1200,
    output_tokens: 88,
    cache_creation_input_tokens: 340,
    cache_read_input_tokens: 5600,
  },
};

export const assistantThinkingRecord = {
  parentUuid: "u-0001",
  uuid: "a-0001",
  timestamp: "2026-09-29T09:00:12.500Z",
  type: "assistant",
  message: {
    ...messageBase,
    content: [
      {
        type: "thinking",
        thinking: "用户想了解结构，先列目录。",
        visible: false,
      },
    ],
  },
  requestId: "req_01ABC",
  slug: "repo-structure",
  entrypoint: "cli",
  ...baseFields,
};

export const assistantTextRecord = {
  parentUuid: "u-0001",
  uuid: "a-0002",
  timestamp: "2026-09-29T09:00:12.900Z",
  type: "assistant",
  message: {
    ...messageBase,
    content: [{ type: "text", text: "我先看一下目录。" }],
  },
  requestId: "req_01ABC",
  ...baseFields,
};

export const assistantToolUseRecord = {
  parentUuid: "u-0001",
  uuid: "a-0003",
  timestamp: "2026-09-29T09:00:13.100Z",
  type: "assistant",
  message: {
    ...messageBase,
    content: [
      {
        type: "tool_use",
        id: "toolu_01A",
        name: "Bash",
        input: { command: "ls", description: "List files" },
      },
    ],
  },
  requestId: "req_01ABC",
  ...baseFields,
};

/**
 * The tool_result of `toolu_01A` — in real transcripts this record lands
 * BETWEEN the message's own records (streamed tool execution), so it must
 * not close or split the open message group.
 */
export const interleavedToolResultRecord = {
  parentUuid: "a-0003",
  uuid: "u-0006",
  timestamp: "2026-09-29T09:00:14.200Z",
  type: "user",
  message: {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_01A", content: "file-a.ts" },
    ],
  },
  toolUseResult: { stdout: "file-a.ts" },
  ...baseFields,
};

/** An errored tool result — its text becomes the result event's error. */
export const erroredToolResultRecord = {
  parentUuid: "a-0003",
  uuid: "u-0007",
  timestamp: "2026-09-29T09:00:15.000Z",
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_01A",
        is_error: true,
        content: "command not found: nosuchbin",
      },
    ],
  },
  ...baseFields,
};

/** The NEXT message — a different message.id closes the previous group. */
export const NEXT_MSG_ID = "msg_02ABC";

export const nextMessageRecord = {
  parentUuid: "u-0006",
  uuid: "a-0004",
  timestamp: "2026-09-29T09:00:20.000Z",
  type: "assistant",
  message: {
    id: NEXT_MSG_ID,
    model: "claude-sonnet-4-5",
    role: "assistant",
    content: [{ type: "text", text: "这是第二段回复。" }],
    usage: { input_tokens: 1300, output_tokens: 40 },
  },
  ...baseFields,
};

/** Legacy client-generated title record (old builds). */
export const summaryRecord = {
  type: "summary",
  summary: "梳理 slopwatch 仓库结构",
  leafUuid: "a-0001",
};

/** Modern title record — carries no timestamp. */
export const aiTitleRecord = {
  type: "ai-title",
  aiTitle: "repo 结构梳理",
  sessionId: SESSION,
};

/** A 1×1 transparent PNG (smallest valid payload for image capture). */
export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A prompt carrying an inline pasted image (base64 source block). */
export const imagePromptRecord = {
  parentUuid: null,
  uuid: "u-0008",
  timestamp: "2026-09-29T09:01:00.000Z",
  type: "user",
  origin: { kind: "human" },
  promptSource: "typed",
  imagePasteIds: [1],
  message: {
    role: "user",
    content: [
      { type: "text", text: "这张截图里是什么问题？" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: TINY_PNG_BASE64,
        },
      },
    ],
  },
  ...baseFields,
};

/** A tool result that returned a screenshot image block. */
export const toolResultImageRecord = {
  parentUuid: "a-0003",
  uuid: "u-0009",
  timestamp: "2026-09-29T09:01:30.000Z",
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_01A",
        content: [
          { type: "text", text: "[screen captured]" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: TINY_PNG_BASE64,
            },
          },
        ],
      },
    ],
  },
  ...baseFields,
};

/** Inline subagent traffic on the primary transcript — never the parent's turn. */
export const sidechainAssistantRecord = {
  parentUuid: "u-0001",
  uuid: "a-side-1",
  timestamp: "2026-09-29T09:02:00.000Z",
  type: "assistant",
  message: {
    id: "msg_side01",
    model: "claude-sonnet-4-5",
    role: "assistant",
    content: [{ type: "text", text: "sidechain work" }],
    usage: { input_tokens: 10, output_tokens: 5 },
  },
  ...baseFields,
  isSidechain: true,
};

/** First record of a subagent child transcript (`subagents/agent-<id>.jsonl`). */
export const AGENT_ID = "a620ffb7887c70fb4";

export const subagentPromptRecord = {
  parentUuid: null,
  uuid: "sa-0001",
  timestamp: "2026-09-29T09:02:10.000Z",
  type: "user",
  isSidechain: true,
  agentId: AGENT_ID,
  promptId: "p-100",
  message: { role: "user", content: "在子代理里搜索实现" },
  version: "2.1.284",
  sessionId: SESSION,
  session_id: SESSION,
  userType: "external",
  entrypoint: "cli",
  cwd: "D:\\repo",
  gitBranch: "main",
};

/** The child's assistant reply — same message-per-record shape as the parent. */
export const subagentAssistantRecord = {
  parentUuid: "sa-0001",
  uuid: "sa-0002",
  timestamp: "2026-09-29T09:02:12.000Z",
  type: "assistant",
  agentId: AGENT_ID,
  message: {
    id: "msg_sub01",
    model: "claude-sonnet-4-5",
    role: "assistant",
    content: [{ type: "text", text: "找到了实现。" }],
    usage: { input_tokens: 900, output_tokens: 60 },
  },
  ...baseFields,
  isSidechain: true,
};
