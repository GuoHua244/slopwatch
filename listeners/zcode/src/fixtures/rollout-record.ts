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
  response: { ...mainTurnRecord.response, toolCalls: undefined },
};

export const noResponseRecord: Record<string, unknown> = {
  ...mainTurnRecord,
  requestId: "req_demo-0003",
  turnId: "turn_demo-2",
  response: undefined,
};
