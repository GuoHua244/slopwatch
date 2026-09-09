/**
 * @slopwatch/listener-claude-code — the per-session capture sidecar for
 * Claude Code.
 *
 * Capture surfaces (research/coding-agent-ingestion.md, "Claude Code"): the
 * JSONL transcript at `~/.claude/projects/<cwd-hash>/<session-uuid>.jsonl`
 * tailed by `live.ts`, spawned detached by `hook.ts` — the hook script that
 * install.ts wires into Claude Code's settings for SessionStart,
 * UserPromptSubmit (re-spawn after idle), and SessionEnd (ships the end
 * event, kills the sidecar). Hooks pass their payload as JSON on stdin.
 */
export {
  eventsFromRecord,
  metaFromRecord,
  newTailState,
  turnIdOf,
} from "./normalizer";
export { planHook } from "./hook";
export { HOOK_EVENTS, mergeHookConfig, slopwatchHookCommand } from "./install";
