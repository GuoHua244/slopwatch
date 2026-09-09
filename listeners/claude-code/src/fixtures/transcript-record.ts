/**
 * Fixtures shaped like Claude Code transcript records
 * (`~/.claude/projects/<hash>/<session-uuid>.jsonl`). The schema is
 * undocumented — these capture the fields the adapter relies on, pinned
 * against a real capture from 2026-09-10.
 */
export const promptRecord = {
  parentUuid: null,
  sessionId: "3f1d9c2e-1111-4bbb-9c2e-000000000001",
  type: "user",
  message: { role: "user", content: "帮我看看这个仓库的结构" },
  uuid: "u-0001",
  timestamp: "2026-09-10T09:00:00.000Z",
};

export const metaPromptRecord = {
  ...promptRecord,
  isMeta: true,
  uuid: "u-0002",
  message: {
    role: "user",
    content: "<system-reminder>injected</system-reminder>",
  },
  timestamp: "2026-09-10T09:00:05.000Z",
};

export const assistantRecord = {
  parentUuid: "u-0001",
  sessionId: "3f1d9c2e-1111-4bbb-9c2e-000000000001",
  type: "assistant",
  uuid: "a-0001",
  timestamp: "2026-09-10T09:00:12.500Z",
  requestId: "req_01ABC",
  message: {
    id: "msg_01XYZ",
    model: "claude-sonnet-4-5",
    role: "assistant",
    content: [
      { type: "text", text: "我先看一下目录。" },
      {
        type: "tool_use",
        id: "toolu_01A",
        name: "Bash",
        input: { command: "ls", description: "List files" },
      },
    ],
    usage: {
      input_tokens: 1200,
      output_tokens: 88,
      cache_creation_input_tokens: 340,
      cache_read_input_tokens: 5600,
    },
  },
};

/** Same message.id streamed again — must not double-emit a model_request. */
export const assistantDuplicateRecord = {
  ...assistantRecord,
  parentUuid: "u-0001",
  uuid: "a-0001-dup",
  timestamp: "2026-09-10T09:00:13.000Z",
};

export const toolResultRecord = {
  parentUuid: "a-0001",
  sessionId: "3f1d9c2e-1111-4bbb-9c2e-000000000001",
  type: "user",
  uuid: "u-0003",
  timestamp: "2026-09-10T09:00:14.200Z",
  message: {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_01A", content: "file-a.ts" },
    ],
  },
  toolUseResult: { stdout: "file-a.ts" },
};

export const summaryRecord = {
  type: "summary",
  summary: "梳理 slopwatch 仓库结构",
  leafUuid: "a-0001",
};
