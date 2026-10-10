/**
 * Fixtures shaped like CodeBuddy history files
 * (`<LOCALAPPDATA>/CodeBuddyExtension/Data/<instance>/CodeBuddyIDE/<instance>/history/…`).
 *
 * Pinned against a real Windows capture (2026-10-08, hook-reported agent
 * version `4.12.1`, model `hy4-preview-f`). Prose inside the samples is
 * trimmed — the field structure, the double-encoded `message`/`extra`, the
 * ids, and every number are verbatim; nothing here was invented to make the
 * code pass. Key real-world facts they encode:
 *
 * - the conversation manifest is a single-line object with `messages` +
 *   `requests` arrays, rewritten whole on every step (never line-appended);
 * - one message = one file, written ONCE (identical bytes and mtime hours
 *   later), so "seen once" is a safe dedup key;
 * - `message`/`extra` are JSON encoded inside a JSON value;
 * - tool results arrive twice — as the assistant's own `extra.toolStatus`
 *   and as `tool`-role messages;
 * - **no message anywhere carries token counts** — those come from the log
 *   lines in {@link realUsageLogLines};
 * - the workspace index's `name` is the first user message, i.e. the title.
 */

const CONVERSATION = "775cc5f8f8604b798be88bbf9bc3c06d";
export const REQUEST = "00592a8d23944ff7b9422c179366547d";
const TRACE = "3b4e456c29373c181d8f681f9c309d51";

/** `<conversation>/index.json` — trimmed to two messages of one request. */
export const realConversationIndexJson = `{"messages":[{"id":"1fc7b522dffc457486d3a99629366b4b","type":"text","role":"user","isComplete":true},{"id":"d0e251f82b41488ca2d456dd4b18e7fe","type":"text","role":"assistant","isComplete":false},{"id":"cc7951d200064e10b02ac237e02ccc19","type":"text","role":"tool","isComplete":true}],"requests":[{"id":"${REQUEST}","type":"craft","messages":["1fc7b522dffc457486d3a99629366b4b","d0e251f82b41488ca2d456dd4b18e7fe","cc7951d200064e10b02ac237e02ccc19"],"state":"running"}]}`;

/** The lean form a conversation starts life as. */
export const emptyConversationIndexJson = `{"messages":[],"requests":[]}`;

/** A user message file — note `references`, absent elsewhere. */
export const realUserMessageJson = `{
  "role": "user",
  "message": "{\\"role\\":\\"user\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"<user_info>\\\\nOS Version: win32\\\\n<\\\\/user_info>\\\\n\\\\n# 任务：为 slopwatch 新增 CodeBuddy listener\\\\n（目标是 this repo）\\"}]}",
  "id": "1fc7b522dffc457486d3a99629366b4b",
  "references": [],
  "extra": "{\\"requestId\\":\\"${REQUEST}\\",\\"modelId\\":\\"hy4-preview-f\\",\\"modelName\\":\\"Hy4 preview\\",\\"isHelperMessage\\":false,\\"traceId\\":\\"${TRACE}\\",\\"sourceContentBlocks\\":[{\\"type\\":\\"text\\",\\"text\\":\\"# 任务：为 slopwatch 新增 CodeBuddy listener\\"}]}",
  "createdAt": "2026-10-08T10:37:59.000Z"
}`;

/**
 * An assistant message file: reasoning + two tool calls, with the runs'
 * results already inlined under `extra.toolStatus`.
 */
export const realAssistantMessageJson = `{
  "role": "assistant",
  "message": "{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"reasoning\\",\\"text\\":\\"Let me explore the repo structure.\\"},{\\"type\\":\\"tool-call\\",\\"toolCallId\\":\\"call_3abe7045bac04b89b2032e5e\\",\\"toolName\\":\\"list_dir\\",\\"args\\":{\\"target_directory\\":\\"d:/studySpace/slopwatch\\"}},{\\"type\\":\\"tool-call\\",\\"toolCallId\\":\\"call_787a8ff6d6fd4af3868fbfd3\\",\\"toolName\\":\\"read_file\\",\\"args\\":{\\"filePath\\":\\"AGENTS.md\\"}}],\\"providerOptions\\":{\\"openaiCompatible\\":{\\"reasoning\\":\\"Let me explore the repo structure.\\"}}}",
  "id": "f47957d9eb514aba9c91a6e0cbe0843b",
  "extra": "{\\"requestId\\":\\"${REQUEST}\\",\\"modelId\\":\\"hy4-preview-f\\",\\"modelName\\":\\"Hy4 preview\\",\\"isHelperMessage\\":false,\\"traceId\\":\\"${TRACE}\\",\\"toolStatus\\":{\\"call_3abe7045bac04b89b2032e5e\\":{\\"ready\\":true,\\"status\\":\\"executed\\",\\"args\\":{\\"target_directory\\":\\"d:/studySpace/slopwatch\\"},\\"result\\":{\\"status\\":\\"success\\",\\"success\\":true,\\"result\\":{\\"type\\":\\"list_files_result\\",\\"files\\":[],\\"root\\":\\"d:/studySpace/slopwatch\\",\\"listing\\":\\"d:/studySpace/slopwatch/\\\\n  - research/\\"}},\\"pendingConfirmation\\":false},\\"call_787a8ff6d6fd4af3868fbfd3\\":{\\"ready\\":true,\\"status\\":\\"executed\\",\\"args\\":{\\"filePath\\":\\"AGENTS.md\\"},\\"result\\":{\\"status\\":\\"success\\",\\"success\\":true,\\"result\\":{\\"type\\":\\"read_result\\",\\"file\\":{\\"filePath\\":\\"AGENTS.md\\"}},\\"root\\":\\"d:/studySpace/slopwatch\\"},\\"pendingConfirmation\\":false}}}",
  "createdAt": "2026-10-08T10:38:07.946Z"
}`;

/** A `tool`-role message file — the second copy of a result. */
export const realToolMessageJson = `{
  "role": "tool",
  "message": "{\\"role\\":\\"tool\\",\\"content\\":[{\\"type\\":\\"tool-result\\",\\"toolCallId\\":\\"call_a71647a5f831430cb60c755e\\",\\"toolName\\":\\"execute_command\\",\\"result\\":{\\"status\\":\\"success\\",\\"success\\":true,\\"result\\":{\\"type\\":\\"execute_command_result\\",\\"stdout\\":\\"=== bin ===\\\\nbuddycn       2018\\",\\"stderr\\":\\"\\",\\"exitCode\\":0}}}]}",
  "id": "0740d14f8f2a44049ccfd79791f4babd",
  "extra": "{\\"requestId\\":\\"${REQUEST}\\",\\"modelId\\":\\"hy4-preview-f\\",\\"modelName\\":\\"Hy4 preview\\",\\"isHelperMessage\\":false,\\"traceId\\":\\"${TRACE}\\"}",
  "createdAt": "2026-10-08T10:40:00.000Z"
}`;

/** A failed tool run (PermissionEngine denies, or a nonzero exit). */
export const failedToolMessageJson = `{
  "role": "tool",
  "message": "{\\"role\\":\\"tool\\",\\"content\\":[{\\"type\\":\\"tool-result\\",\\"toolCallId\\":\\"call_dead0000beef4321abcd0000\\",\\"toolName\\":\\"execute_command\\",\\"result\\":{\\"status\\":\\"error\\",\\"success\\":false,\\"error\\":\\"command not permitted\\"}}]}",
  "id": "aaaad14f8f2a44049ccfd79791f4bab0",
  "extra": "{\\"requestId\\":\\"${REQUEST}\\",\\"modelId\\":\\"hy4-preview-f\\",\\"modelName\\":\\"Hy4 preview\\",\\"isHelperMessage\\":false,\\"traceId\\":\\"${TRACE}\\"}",
  "createdAt": "2026-10-08T10:41:00.000Z"
}`;

/** `<workspace>/index.json` — `name` is the first user message (the title). */
export const realWorkspaceIndexJson = `{
  "conversations": [
    {
      "id": "${CONVERSATION}",
      "type": "craft",
      "name": "# 任务：为 slopwatch 新增 CodeBuddy listener\\r\\n（目标是 this repo）",
      "createdAt": "2026-10-08T10:29:12.370Z",
      "lastMessageAt": "2026-10-08T10:53:20.556Z",
      "maxModeMap": { "__conversation__": true },
      "chatMode": "craft",
      "selectedModelId": "hy4-preview-f",
      "selectionRevision": 1
    }
  ],
  "current": "${CONVERSATION}"
}`;

/**
 * Verbatim agent-log lines (2026-10-08). The `notifyStepEnd` line carries the
 * usage keyed by `messageId`; the same-millisecond metrics line repairs the
 * duration.
 */
export const realUsageLogLines = [
  `[2026/10/8 18:38:04.276] [Info] [BaseAgent:craft] [${REQUEST}]  notifyStepEnd, step: 1, requestId: ${REQUEST}, messageId: d0e251f82b41488ca2d456dd4b18e7fe, usage: {"inputTokens":12633,"outputTokens":59,"totalTokens":12692,"cacheTokens":4224,"cachedWriteTokens":0,"cachedMissTokens":8409,"lastTokens":12692,"credit":0,"thinkingTokens":59}, isMaxTokenLimit: false, isMaxStepLimit: false, hasReactiveTool:false, isContentFilter: false`,
  `[2026/10/8 18:38:04.276] [Info] [AgentReporter] [${TRACE}]  Step execution metrics: step=1, duration=4381ms, usage={"inputTokens":12633,"outputTokens":59,"totalTokens":12692,"cacheTokens":4224,"cachedWriteTokens":0,"cachedMissTokens":8409,"lastTokens":12692,"credit":0,"thinkingTokens":59}`,
  `[2026/10/8 18:38:07.947] [Info] [BaseAgent:craft] [${REQUEST}]  notifyStepEnd, step: 2, requestId: ${REQUEST}, messageId: f47957d9eb514aba9c91a6e0cbe0843b, usage: {"inputTokens":15714,"outputTokens":71,"totalTokens":15785,"cacheTokens":12608,"cachedWriteTokens":0,"cachedMissTokens":3106,"lastTokens":15785,"credit":0,"thinkingTokens":12}, isMaxTokenLimit: false, isMaxStepLimit: false, hasReactiveTool:false, isContentFilter: false`,
  `[2026/10/8 18:38:07.947] [Info] [AgentReporter] [${TRACE}]  Step execution metrics: step=2, duration=3021ms, usage={"inputTokens":15714,"outputTokens":71,"totalTokens":15785,"cacheTokens":12608,"cachedWriteTokens":0,"cachedMissTokens":3106,"lastTokens":15785,"credit":0,"thinkingTokens":12}`,
];

/**
 * Verbatim sub-agent lines (2026-10-09), from a `Task` tool run inside this
 * very workspace. A sub-agent is a separate `BaseAgent:<type>` run with its
 * own `requestId` (the run id): it logs its own `notifyStepEnd` usage, but
 * its messages never reach the parent conversation's manifest — so the log
 * is the only place a sub-agent's tokens exist.
 */
export const SUBAGENT_RUN = "c09d2e055d2743d8afde32392d534f88";
export const PRIMARY_RUN = "d149dd4c45c445cda8dba8616c14dd34";

export const realAgentStartLines = [
  `[2026/10/9 12:21:29.062] [Info] [BaseAgent:craft] [${PRIMARY_RUN}]  notifyAgentStart`,
  `[2026/10/9 12:21:50.539] [Info] [BaseAgent:code-explorer] [${SUBAGENT_RUN}]  notifyAgentStart`,
];

export const realSubagentUsageLogLines = [
  `[2026/10/9 12:21:50.541] [Info] [BaseAgent:code-explorer]  DeepSeek ModelProvider initialized, modelId: hy4-preview-f, modelName: Hy4 preview`,
  `[2026/10/9 12:22:00.174] [Info] [BaseAgent:code-explorer] [${SUBAGENT_RUN}]  notifyStepEnd, step: 1, requestId: ${SUBAGENT_RUN}, messageId: 8c0fbe4372844b9aa2a69b01d604b18e, usage: {"inputTokens":3346,"outputTokens":92,"totalTokens":3438,"cacheTokens":2944,"cachedWriteTokens":0,"cachedMissTokens":402,"lastTokens":3438,"credit":0,"thinkingTokens":0}, isMaxTokenLimit: false, isMaxStepLimit: false, hasReactiveTool:false, isContentFilter: false`,
  `[2026/10/9 12:22:10.338] [Info] [BaseAgent:code-explorer] [${SUBAGENT_RUN}]  notifyStepEnd, step: 2, requestId: ${SUBAGENT_RUN}, messageId: 8729d3a5c2b4450888fcdf1e582e5498, usage: {"inputTokens":4663,"outputTokens":167,"totalTokens":4830,"cacheTokens":3264,"cachedWriteTokens":0,"cachedMissTokens":1399,"lastTokens":4830,"credit":0,"thinkingTokens":26}, isMaxTokenLimit: false, isMaxStepLimit: false, hasReactiveTool:false, isContentFilter: false`,
];

/** A real hook payload (PostToolUse) as CodeBuddy delivers it on stdin. */
export const realHookPayload = {
  hook_event_name: "PostToolUse",
  session_id: CONVERSATION,
  transcript_path:
    "C:\\Users\\Administrator\\AppData\\Local\\CodeBuddyExtension\\Data\\0d54d05f-44cd-4a97-9470-348b316b76e0\\CodeBuddyIDE\\0d54d05f-44cd-4a97-9470-348b316b76e0\\history\\4c38fe68bcba317535704f74187134e3\\775cc5f8f8604b798be88bbf9bc3c06d\\index.json",
  // NOTE: verbatim from the machine — the IDE's own install directory, NOT
  // the workspace. Never trust this field for the session's cwd.
  cwd: "D:\\software\\CodeBuddy CN",
  tool_name: "Write",
  tool_input: { filePath: "probe.mjs" },
  tool_response: { success: true },
  model: "hy4-preview-f",
  generation_id: REQUEST,
  client: "CodeBuddyIDE",
  version: "4.12.1",
  agent_type: { kind: "main" },
};

/** md5("d:\\studySpace\\slopwatch") — the real workspace hash for this session. */
export const REAL_WORKSPACE_HASH = "4c38fe68bcba317535704f74187134e3";
export const REAL_WORKSPACE_PATH = "d:\\studySpace\\slopwatch";
export const REAL_CONVERSATION_ID = CONVERSATION;
