// Synthetic fixtures with the exact shape of real ZCode rollout records
// (~/.zcode/cli/rollout/model-io-sess_*.jsonl) — content redacted, keys real.

export const mainTurnRecord = {
  type: "model_io",
  sessionId: "sess_demo-0001",
  turnId: "turn_demo-1",
  querySource: "main_turn",
  startedAt: "2026-09-09T10:23:30.610Z",
  completedAt: "2026-09-09T10:23:34.250Z",
  durationMs: 3640,
  requestId: "req_demo-0001",
  attempt: 1,
  traceId: "trace_demo-0001",
  model: {
    modelId: "GLM-5.3-Flash",
    providerId: "builtin:bigmodel-coding-plan",
    role: "lite",
    source: "session",
    variant: "max",
  },
  request: {
    messages: [
      { role: "user", content: "Hi ZCode，给我介绍一下 slopwatch 吧" },
      { role: "assistant", content: "I'll take a look." },
    ],
    body: {
      model: "GLM-5.3-Flash",
      max_tokens: 128000,
      messages: [{ role: "user", content: "demo fixture prompt" }],
    },
  },
  response: {
    finishReason: "tool-calls",
    modelId: "GLM-5.3-Flash",
    responseId: "resp_demo-0001",
    text: "Spawning a subagent for that.",
    reasoningText: "demo reasoning",
    toolCalls: [{ id: "tc_demo-1", name: "Agent", input: { prompt: "demo" } }],
    usage: {
      inputTokens: 237,
      outputTokens: 131,
      totalTokens: 368,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  },
};

export const titleRecord: Record<string, unknown> = {
  ...mainTurnRecord,
  requestId: "req_demo-0002",
  turnId: undefined,
  querySource: "session_title",
  request: {
    messages: [
      { role: "user", content: "Hi ZCode，给我介绍一下 slopwatch 吧" },
    ],
  },
  response: {
    ...mainTurnRecord.response,
    toolCalls: undefined,
    text: '{"title":"介绍一下 slopwatch"}',
  },
};

export const noResponseRecord: Record<string, unknown> = {
  ...mainTurnRecord,
  requestId: "req_demo-0003",
  turnId: "turn_demo-2",
  response: undefined,
};

// A subagent's rollout record: same traceId as its parent session (the claim
// key), own session id, querySource "subagent". Real files are named
// model-io-sess_subagent_agent_<uuid>.jsonl.
export const subagentRecord: Record<string, unknown> = {
  ...mainTurnRecord,
  sessionId: "sess_subagent_agent_demo-1",
  turnId: "turn_sub-1",
  querySource: "subagent",
  requestId: "req_sub-0001",
  request: {
    messages: [
      {
        role: "user",
        content: "Search the codebase for rollout capture gaps",
      },
    ],
  },
  response: {
    ...mainTurnRecord.response,
    text: "Found the gap in files discovery.",
    toolCalls: [
      { id: "tc_sub-1", name: "Grep", input: { pattern: "model-io" } },
    ],
    usage: {
      inputTokens: 500,
      outputTokens: 40,
      totalTokens: 540,
      cacheReadTokens: 300,
      cacheWriteTokens: 0,
    },
  },
};

export const secondSubagentRecord: Record<string, unknown> = {
  ...subagentRecord,
  requestId: "req_sub-0002",
  response: {
    finishReason: "stop",
    modelId: "GLM-5.3-Flash",
    responseId: "resp_sub-0002",
    text: "Done.",
    usage: {
      inputTokens: 700,
      outputTokens: 25,
      totalTokens: 725,
      cacheReadTokens: 500,
      cacheWriteTokens: 0,
    },
  },
};

// Another session's subagent: the traceId does not match, so a live listener
// for a different main session must never adopt this file.
export const foreignSubagentRecord: Record<string, unknown> = {
  ...subagentRecord,
  sessionId: "sess_subagent_agent_foreign-9",
  requestId: "req_foreign-0001",
  traceId: "trace_other-session",
};
