/**
 * Codex rollout records pinned to real machine captures (codex-cli 0.147.0
 * exec runs + Codex Desktop 0.169.0-alpha sessions, Windows; verified
 * against openai/codex rust-v0.147.0 source). Values are real where they
 * matter (usage numbers, field names, payload shapes), content is
 * anonymized where it does not.
 */

export const SESSION_ID = "01a1ee57-d154-7343-8b7c-59137e2b8fbd";
export const TURN_ID = "01a1ee57-d1db-7550-8ed5-2e01212a3a0e";
export const CALL_ID = "call_E9f2a1c4b7d84e6f";

/** Codex Desktop 0.169.0-alpha session_meta (line 0 of a paginated file). */
export const sessionMetaRecord = {
  timestamp: "2026-11-18T02:20:44.613Z",
  ordinal: 0,
  type: "session_meta",
  payload: {
    account_scoped: true,
    session_id: SESSION_ID,
    id: SESSION_ID,
    timestamp: "2026-11-18T02:20:43.676Z",
    cwd: "D:\\workspace\\gitlab",
    runtime_workspace_roots: ["D:\\workspace\\gitlab"],
    originator: "Codex Desktop",
    cli_version: "0.169.0-alpha.11.1",
    source: "vscode",
    thread_source: "user",
    model_provider: "custom",
    base_instructions: { text: "You are Codex, a coding agent..." },
    history_mode: "paginated",
    git: {
      commit_hash: "f99f61bd8e2a4c1e9d3b",
      branch: "cgh-feat-6297",
      repository_url: "http://192.168.21.166/xunxia/server/xunxia-server.git",
    },
  },
};

/** codex_exec 0.147.0 session_meta — minimal: no git, no account_scoped. */
export const execSessionMetaRecord = {
  timestamp: "2026-11-13T06:51:03.219Z",
  type: "session_meta",
  payload: {
    session_id: SESSION_ID,
    id: SESSION_ID,
    timestamp: "2026-11-13T06:51:02.884Z",
    cwd: "D:\\studySpace\\slopwatch",
    originator: "codex_exec",
    cli_version: "0.147.0",
    source: "exec",
    thread_source: "user",
    model_provider: "custom",
    base_instructions: { text: "You are Codex, a coding agent..." },
  },
};

/** A subagent thread's session_meta — separate file, parent thread id. */
export const subagentMetaRecord = {
  timestamp: "2026-11-18T03:01:10.102Z",
  ordinal: 0,
  type: "session_meta",
  payload: {
    session_id: SESSION_ID, // root thread id — shared with the parent file
    id: "01a1ee58-9ab2-7c31-8e44-3d6b52f10a77",
    timestamp: "2026-11-18T03:01:09.887Z",
    cwd: "D:\\workspace\\gitlab",
    originator: "Codex Desktop",
    cli_version: "0.169.0-alpha.11.1",
    source: {
      subagent: {
        thread_spawn: {
          parent_thread_id: SESSION_ID,
          depth: 1,
          agent_path: null,
          agent_nickname: "Descartes",
          agent_role: "default",
        },
      },
    },
    thread_source: "subagent",
    model_provider: "custom",
    history_mode: "paginated",
  },
};

/** A real user prompt (response_item message, role user). */
export const userPromptRecord = {
  timestamp: "2026-11-18T02:20:47.291Z",
  ordinal: 5,
  type: "response_item",
  payload: {
    type: "message",
    id: "msg_0a1b2c3d",
    role: "user",
    content: [
      { type: "input_text", text: "把 listeners 目录下的测试跑一遍并汇报结果" },
    ],
  },
};

/** Harness injection: a user-role message that is ONLY an environment
 * context wrapper — never a prompt. */
export const environmentContextRecord = {
  timestamp: "2026-11-18T02:20:47.100Z",
  ordinal: 4,
  type: "response_item",
  payload: {
    type: "message",
    id: "msg_env_0001",
    role: "user",
    content: [
      {
        type: "input_text",
        text: "<environment_context>\n  <cwd>D:\\workspace\\gitlab</cwd>\n  <shell>powershell</shell>\n</environment_context>",
      },
    ],
  },
};

/** Harness injection: AGENTS.md instructions wrapped as a user message. */
export const agentsMdRecord = {
  timestamp: "2026-11-18T02:20:47.150Z",
  ordinal: 5,
  type: "response_item",
  payload: {
    type: "message",
    id: "msg_agents_0001",
    role: "user",
    content: [
      {
        type: "input_text",
        text: "# AGENTS.md instructions for D:\\workspace\\gitlab\\AGENTS.md\n\n<INSTRUCTIONS>\n- Write commit messages in English\n</INSTRUCTIONS>",
      },
    ],
  },
};

/** A real prompt wrapped with instructions — the words follow the
 * `## My request for Codex:` marker (upstream strip_user_message_prefix). */
export const markedPromptRecord = {
  timestamp: "2026-11-18T02:20:47.200Z",
  ordinal: 6,
  type: "response_item",
  payload: {
    type: "message",
    id: "msg_marked_0001",
    role: "user",
    content: [
      {
        type: "input_text",
        text: "<user_instructions>\nAGENTS.md content here\n</user_instructions>\n\n## My request for Codex:\n修复 cursor 的缩水重置逻辑",
      },
    ],
  },
};

/** A mixed user message: one wrapper item + one real speech item
 * (Desktop sends the context and the prompt as separate items of one
 * message). */
export const mixedPromptRecord = {
  timestamp: "2026-11-18T02:20:47.250Z",
  ordinal: 7,
  type: "response_item",
  payload: {
    type: "message",
    id: "msg_mixed_0001",
    role: "user",
    content: [
      {
        type: "input_text",
        text: "<app-context>desktop context</app-context>",
      },
      { type: "input_text", text: "看看 CI 为什么红了" },
    ],
  },
};

/** Assistant speech (one model response's prose). */
export const assistantMessageRecord = {
  timestamp: "2026-11-18T02:21:01.400Z",
  ordinal: 10,
  type: "response_item",
  payload: {
    type: "message",
    id: "msg_9f8e7d6c",
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text: "测试全部通过：normalizer 12 个用例、drift 4 个用例。",
        annotations: [],
        logprobs: [],
      },
    ],
    phase: "commentary",
  },
};

/** Tool call (function_call — arguments is a JSON STRING). */
export const functionCallRecord = {
  timestamp: "2026-11-18T02:20:55.310Z",
  ordinal: 8,
  type: "response_item",
  payload: {
    type: "function_call",
    status: "completed",
    id: "fc_0e1d2c3b",
    name: "exec_command",
    arguments: `{"cmd":["bash","-lc","bun test listeners"],"cwd":"D:\\\\workspace\\\\gitlab"}`,
    call_id: CALL_ID,
  },
};

/** Tool result (function_call_output — no ok flag). */
export const functionCallOutputRecord = {
  timestamp: "2026-11-18T02:20:58.830Z",
  ordinal: 9,
  type: "response_item",
  payload: {
    type: "function_call_output",
    id: "fco_5a4b3c2d",
    call_id: CALL_ID,
    output:
      "42 pass\n0 fail\nRan 42 tests across 5 files\n\n... command output truncated for persistence ...",
  },
};

/** Turn start (paginated event_msg). */
export const taskStartedRecord = {
  timestamp: "2026-11-18T02:20:48.050Z",
  ordinal: 11,
  type: "event_msg",
  payload: {
    type: "task_started",
    turn_attribution: {
      turn_id: TURN_ID,
      turn_trigger: "composer",
      parent_turn_id: null,
      root_turn_id: TURN_ID,
    },
    turn_id: TURN_ID,
    root_turn_id: TURN_ID,
    started_at: 1794968444,
    model_context_window: 950000,
    collaboration_mode_kind: "default",
  },
};

/** Turn end — the final assistant text rides last_agent_message. */
export const taskCompleteRecord = {
  timestamp: "2026-11-18T02:21:02.100Z",
  ordinal: 14,
  type: "event_msg",
  payload: {
    type: "task_complete",
    root_turn_id: TURN_ID,
    turn_id: TURN_ID,
    last_agent_message: "测试全部通过：normalizer 12 个用例、drift 4 个用例。",
    started_at: 1794968448,
    completed_at: 1794968462,
    duration_ms: 14000,
    time_to_first_token_ms: 900,
  },
};

/** Interrupted turn. */
export const turnAbortedRecord = {
  timestamp: "2026-11-16T08:20:05.000Z",
  ordinal: 40,
  type: "event_msg",
  payload: {
    type: "turn_aborted",
    root_turn_id: TURN_ID,
    turn_id: TURN_ID,
    reason: "interrupted",
    started_at: 1794562281,
    completed_at: 1794562805,
    duration_ms: 524128,
  },
};

/** token_usage_record (0.169+): per-response usage + response_id + thread
 * totals. Real numbers from a captured Desktop session's first response. */
export const tokenUsageRecord = {
  timestamp: "2026-11-18T02:21:00.954Z",
  ordinal: 12,
  type: "token_usage_record",
  payload: {
    thread_id: SESSION_ID,
    turn_id: TURN_ID,
    session_id: SESSION_ID,
    root_turn_id: TURN_ID,
    response_id: "dafe75a3-8d4f-4b46-ac2b-c09da7ebee95",
    usage: {
      input_tokens: 40814,
      cached_input_tokens: 27136,
      cache_write_input_tokens: 0,
      output_tokens: 258,
      reasoning_output_tokens: 0,
      total_tokens: 41072,
    },
    turn_token_usage: {
      input_tokens: 40814,
      cached_input_tokens: 27136,
      cache_write_input_tokens: 0,
      output_tokens: 258,
      reasoning_output_tokens: 0,
      total_tokens: 41072,
    },
    thread_token_usage: {
      input_tokens: 40814,
      cached_input_tokens: 27136,
      cache_write_input_tokens: 0,
      output_tokens: 258,
      reasoning_output_tokens: 0,
      total_tokens: 41072,
    },
  },
};

/** token_count (event_msg): the SAME response ~1s later, identical numbers —
 * the duplicate the adapter must skip once a token_usage_record is seen. */
export const tokenCountRecord = {
  timestamp: "2026-11-18T02:21:02.015Z",
  ordinal: 15,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: 40814,
        cached_input_tokens: 27136,
        cache_write_input_tokens: 0,
        output_tokens: 258,
        reasoning_output_tokens: 0,
        total_tokens: 41072,
      },
      last_token_usage: {
        input_tokens: 40814,
        cached_input_tokens: 27136,
        cache_write_input_tokens: 0,
        output_tokens: 258,
        reasoning_output_tokens: 0,
        total_tokens: 41072,
      },
      last_usage_includes_reasoning: false,
      model_context_window: 950000,
    },
    rate_limits: {
      limit_id: "codex",
      limit_name: null,
      primary: null,
      secondary: null,
    },
  },
};

/** token_count on a 0.147-era file — the only usage source there. */
export const tokenCountOnlyRecord = {
  timestamp: "2026-11-13T06:51:10.412Z",
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: 1240,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 42,
        reasoning_output_tokens: 0,
        total_tokens: 1282,
      },
      last_token_usage: {
        input_tokens: 1240,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 42,
        reasoning_output_tokens: 0,
        total_tokens: 1282,
      },
      last_usage_includes_reasoning: false,
      model_context_window: 272000,
    },
    rate_limits: null,
  },
};

/** Per-turn settings (the authoritative model). */
export const turnContextRecord = {
  timestamp: "2026-11-18T02:20:47.900Z",
  ordinal: 10,
  type: "turn_context",
  payload: {
    turn_id: TURN_ID,
    root_turn_id: TURN_ID,
    disabled_plugin_ids: [],
    cwd: "D:\\workspace\\gitlab",
    approval_policy: "never",
    permission_profile: { type: "disabled" },
    model: "deepseek/deepseek-flash",
    collaboration_mode: {
      mode: "default",
      settings: { model: "deepseek/deepseek-flash", reasoning_effort: "max" },
    },
    effort: "max",
    summary: "none",
    sandbox_policy: { type: "danger-full-access" },
  },
};

/** A model change mid-session (thread_settings_applied). */
export const threadSettingsRecord = {
  timestamp: "2026-11-18T03:30:00.000Z",
  ordinal: 100,
  type: "event_msg",
  payload: {
    type: "thread_settings_applied",
    thread_id: SESSION_ID,
    thread_settings: {
      model: "glm-5.3",
      model_provider_id: "custom",
      approval_policy: "never",
    },
  },
};

/** Paginated UI mirror of a command execution — deliberately eventless. */
export const itemCompletedRecord = {
  timestamp: "2026-11-18T02:20:58.900Z",
  ordinal: 13,
  type: "event_msg",
  payload: {
    type: "item_completed",
    thread_id: SESSION_ID,
    turn_id: TURN_ID,
    item: {
      type: "CommandExecution",
      command: "bun test listeners",
      cwd: "D:\\workspace\\gitlab",
      aggregated_output: "42 pass",
      exit_code: 0,
      status: "completed",
    },
    started_at_ms: 1795000095421,
    completed_at_ms: 1795000099015,
  },
};

/** Bookkeeping baseline snapshot — known-ignored. */
export const worldStateRecord = {
  timestamp: "2026-11-18T02:20:44.700Z",
  ordinal: 1,
  type: "world_state",
  payload: {
    full: true,
    state: {
      agents_md: {
        directory: "D:\\workspace\\gitlab",
        text: "# Slopwatch agent instructions",
      },
    },
  },
};

/** Compaction/summary record (kept for retrospectives, no event). */
export const compactedRecord = {
  timestamp: "2026-11-16T10:09:44.833Z",
  ordinal: 4761,
  type: "compacted",
  payload: {
    message:
      "Another language model started to solve this problem...\n# Handoff Summary\n## Task\nRun the listener tests.",
  },
};

/** Legacy history_mode: user_message / agent_message / mcp_tool_call_end. */
export const legacyUserMessageRecord = {
  timestamp: "2026-11-13T06:51:05.000Z",
  type: "event_msg",
  payload: {
    type: "user_message",
    message: "Reply with OK only.",
    images: [],
    local_images: [],
  },
};

export const legacyAgentMessageRecord = {
  timestamp: "2026-11-13T06:51:11.000Z",
  type: "event_msg",
  payload: {
    type: "agent_message",
    message: "OK",
    phase: "final_answer",
    memory_citation: null,
  },
};

export const legacyMcpToolCallRecord = {
  timestamp: "2026-11-13T06:52:30.000Z",
  type: "event_msg",
  payload: {
    type: "mcp_tool_call_end",
    call_id: "call_mcp_0001",
    invocation: {
      server: "mysql-log",
      tool: "execute_sql",
      arguments: { query: "SELECT 1 AS ok" },
    },
    duration: { secs: 0, nanos: 41738000 },
    result: {
      Ok: {
        content: [{ type: "text", text: "ok\n1" }],
        isError: false,
      },
    },
  },
};

/** Alternative tool forms (upstream types, rare locally). */
export const localShellCallRecord = {
  timestamp: "2026-11-18T02:20:56.000Z",
  ordinal: 8,
  type: "response_item",
  payload: {
    type: "local_shell_call",
    status: "completed",
    id: "lsc_0001",
    action: {
      type: "exec",
      command: ["bun", "test"],
      working_directory: "D:\\workspace\\gitlab",
    },
    call_id: "call_ls_9f2e1a",
  },
};

export const webSearchCallRecord = {
  timestamp: "2026-11-18T02:21:10.000Z",
  ordinal: 16,
  type: "response_item",
  payload: {
    type: "web_search_call",
    id: "ws_0001",
    status: "completed",
    action: { type: "search", queries: ["bun test --coverage"] },
  },
};

/** Hook stdin payloads (codex-rs/hooks/src/schema.rs, snake_case). */
export const sessionStartHookPayload = {
  session_id: SESSION_ID,
  transcript_path: `C:\\Users\\me\\.codex\\sessions\\2026\\11\\18\\rollout-2026-11-18T19-08-15-${SESSION_ID}.jsonl`,
  cwd: "D:\\workspace\\gitlab",
  hook_event_name: "SessionStart",
  model: "deepseek/deepseek-flash",
  permission_mode: "bypassPermissions",
  source: "startup",
};

export const sessionEndHookPayload = {
  session_id: SESSION_ID,
  transcript_path: `C:\\Users\\me\\.codex\\sessions\\2026\\11\\18\\rollout-2026-11-18T19-08-15-${SESSION_ID}.jsonl`,
  cwd: "D:\\workspace\\gitlab",
  hook_event_name: "SessionEnd",
  reason: "other",
};

export const stopHookPayload = {
  session_id: SESSION_ID,
  turn_id: TURN_ID,
  transcript_path: `C:\\Users\\me\\.codex\\sessions\\2026\\11\\18\\rollout-2026-11-18T19-08-15-${SESSION_ID}.jsonl`,
  cwd: "D:\\workspace\\gitlab",
  hook_event_name: "Stop",
  model: "deepseek/deepseek-flash",
  permission_mode: "bypassPermissions",
  stop_hook_active: false,
  last_assistant_message: "测试全部通过。",
};
