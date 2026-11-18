# Codex Listener SPEC

The per-agent Listener for OpenAI Codex CLI (and Codex Desktop, which writes
the same rollout files through its bundled codex core). Mirrors the
Claude Code listener's shape (hooks spawn a detached tailer) against the
Codex rollout JSONL format. Machine-verified against codex-cli 0.147.0 and
Codex Desktop 0.169.0-alpha rollouts on Windows; cross-checked against
openai/codex `rust-v0.147.0` source.

## Capture surface

- Rollout files: `<CODEX_HOME|~/.codex>/sessions/YYYY/MM/DD/rollout-<YYYY-MM-DDTHH-MM-SS>-<thread-uuid>[_<rollout-uuid>].jsonl`.
  `CODEX_HOME` relocates the tree. Directory nesting comes from the filename
  timestamp; the cwd lives inside `session_meta`, not the path.
- Cold files are zstd-compressed to `.jsonl.zst` after 7 idle days and
  materialized back on resume — a live capture only ever tails plain
  `.jsonl`; the discovery glob ignores `.zst` siblings.
- Spawn trigger: the Codex hooks system (`hooks` feature, stable and
  default-on since ≤ 0.147.0, Windows supported). `slopwatch install` merges
  command handlers into `~/.codex/hooks.json` (user scope) or
  `<dir>/.codex/hooks.json` (project scope). Hook payloads arrive as JSON on
  **stdin**, snake_case, and carry exactly what the spawner needs:
  `session_id` (thread uuid), `transcript_path` (absolute rollout path),
  `cwd`, `hook_event_name`.
- Wired events: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`
  (turn complete — re-spawn keep-alive), `SessionEnd` (graceful stop).
  The earlier capture-surface survey called the hooks system flag-gated and
  Windows-excluded; that was stale — measured 0.147.0 ships it stable and the
  survey's own `notify` fallback is not needed.
- Trust: handlers run only after the user approves them in the Codex TUI
  ("Hooks need review" → trust). `slopwatch install` prints that step.

## Rollout format → events

Envelope per line: `{ timestamp: RFC3339Z-millis, ordinal?, type, payload }`.
Record types handled vs known-ignored vs drift:

| Top-level type                                                                                                                  | Treatment                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_meta`                                                                                                                  | session facts (cwd, git {branch, repository_url}, originator, cli_version, model_provider). Subagent detection: `thread_source === "subagent"` / `source.subagent.thread_spawn`.                                                                                                                                                                                       |
| `response_item`                                                                                                                 | the durable transcript: `message` (user/assistant), `function_call`, `function_call_output`, `local_shell_call`, `custom_tool_call(_output)`, `web_search_call`. Unknown `payload.type` → quarantine.                                                                                                                                                                  |
| `event_msg`                                                                                                                     | lifecycle + usage: `task_started` (alias `turn_started`), `task_complete` (alias `turn_complete`), `turn_aborted`, `token_count`, `user_message`/`agent_message`/`mcp_tool_call_end` (legacy mode), `thread_settings_applied`. `item_completed` (the paginated UI mirror of response items) is deliberately eventless — emitting from it would double every tool call. |
| `turn_context`                                                                                                                  | per-turn model (`payload.model` > `collaboration_mode.settings.model`)                                                                                                                                                                                                                                                                                                 |
| `token_usage_record`                                                                                                            | per-response usage with `response_id` and cumulative `thread_token_usage` — the preferred usage source (0.169+)                                                                                                                                                                                                                                                        |
| `compacted`                                                                                                                     | eventless (kept in raw records for retrospectives; not a rolling session Summary)                                                                                                                                                                                                                                                                                      |
| `world_state`, `retained_context`, `security_risk_score`, `realtime_item`, `inter_agent_communication`, `dynamic_tools_updated` | known-ignored (no events, no quarantine)                                                                                                                                                                                                                                                                                                                               |
| anything else                                                                                                                   | drift → quarantine verbatim (v2 decision 21)                                                                                                                                                                                                                                                                                                                           |

Mapping:

- **User prompt** → real speech only. Filtered wrappers: `<user_instructions>`,
  `<environment_context>`, `# AGENTS.md instructions …`, `<app-context>`,
  `<skills_instructions>`, `<permissions instructions>`,
  `<collaboration_mode>`, `<turn_aborted>` echoes; a real prompt wrapped with
  `## My request for Codex:` keeps only the text after the marker. The prompt
  text pairs with the next `task_started`'s `turn_id` (prompt record precedes
  it; the reversed order is handled too) → `turn:start`.
- **Assistant speech** → `response_item` `message` role `assistant`
  (`output_text` blocks); rides as `response_text` on the model_request that
  closes the same response. Legacy mode's `agent_message` event feeds it too.
- **Model request** → one usage record per response: `token_usage_record`
  (preferred; `request_id = payload.response_id`, `turn_id = payload.turn_id`)
  or `event_msg token_count` (`info.last_token_usage`, turn id from the open
  turn). Both fire per response in new builds with identical numbers, so once
  a `token_usage_record` is seen, later `token_count`s are skipped (old
  appends in a version-mixed file still pass — they precede the first record).
  Zero-usage replays are skipped, and a cumulative high-water guard drops
  usage records from a reverted thread's replayed prefix.
  Usage mapping: `cached_input_tokens → cache_read_tokens`,
  `cache_write_input_tokens → cache_write_tokens`,
  `reasoning_output_tokens → reasoning_tokens`. Usage rides on
  `model_request` only — that is the sole event the Server sums (sessions
  totals and model rollups), matching the other listeners.
- **Tool call/result** → `function_call` (`name`, `arguments` JSON string →
  parsed `args`, `call_id`) and `function_call_output` (`call_id` → tool name
  via a per-session map). Legacy `mcp_tool_call_end` → `tool:result` with
  duration and ok/error.
- **Turn end** → `task_complete` / `turn_aborted` → `turn:end` (no usage —
  the Server does not sum turn usage and the requests already carry it).
- **Model attribution** → `turn_context.payload.model` and
  `thread_settings_applied.thread_settings.model` update the current model;
  `provider` = `session_meta.model_provider` (e.g. `openai`, `custom`).
- **Session identity** → `session_id` = hook `session_id` = thread uuid =
  `session_meta.payload.id`; the filename uuid is the fallback. Revert forks
  (`<thread>_<rollout>.jsonl`) keep the thread id, so the per-session cursor
  follows the file switch via the tail loop's shrink reset.

## Subagents (child Sessions)

Codex subagent threads are separate rollout files in the same date directory
sharing the root `session_id` (`thread_source: "subagent"`,
`source.subagent.thread_spawn.parent_thread_id`). The parent listener's
`childTails.discover()` reads each sibling's first record and claims the
direct children only (`parent_thread_id === our session id`), brackets them
with child session:start / session:end markers (ADR 0008 rollups), and
announces `↳ <task>` titles from the child's first turn.

## Lifecycle

Hooks spawn `live.ts` detached (liveness = heartbeat file, decision 19);
`SessionEnd` fires after Codex flushes the rollout — the hook posts
`session:end` (2s send budget inside the 3s codex clamp), requests the
graceful `.stop` handshake, and the listener folds its summary before
exiting. Idle timeout (5 min) + max lifetime (4 h) are the fallback, same as
the other listeners. `probeBeforeFold: false` (a SessionEnd hook exists, like
Claude Code).

## Out of scope (v1)

- Attachments (`input_image` items) — no machine-verified capture path yet.
- Titles for primary sessions (thread names live in the separate global
  `session_index.jsonl`, not the rollout).
- `.zst` backfill of cold history (live capture only).
