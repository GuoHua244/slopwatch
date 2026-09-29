/**
 * @slopwatch/listener-claude-code — the per-session capture listener for
 * Claude Code.
 *
 * Capture surfaces (research/coding-agent-ingestion.md, "Claude Code"): the
 * JSONL transcript at `~/.claude/projects/<cwd-hash>/<session-uuid>.jsonl`
 * tailed by `live.ts`, spawned detached by `hook.ts` — the hook script that
 * install.ts wires into Claude Code's settings for SessionStart,
 * UserPromptSubmit (re-spawn after idle), and SessionEnd (ships the end
 * event, kills the listener). Hooks pass their payload as JSON on stdin.
 */
export {
  COMPACTION_MARKER,
  driftFromRecord,
  eventsFromRecord,
  flushOpenMessage,
  IGNORED_RECORD_TYPES,
  isCompactionRecord,
  isRealPromptRecord,
  metaFromRecord,
  newTailState,
  promptTextFromRecord,
  restoreTailState,
  serializeTailState,
} from "./normalizer";
export { createClaudeCodeAdapter } from "./adapter";
export { captureInlineImages, inlineImageBlocks } from "./images";
export { planHook } from "./hook";
export { HOOK_EVENTS, mergeHookConfig, slopwatchHookCommand } from "./install";
