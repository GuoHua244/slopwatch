/**
 * @slopwatch/listener-codebuddy — the per-session capture listener for
 * CodeBuddy (the CodeBuddy CN desktop app's `genie`/`coding-copilot` agent).
 *
 * Capture surfaces (research/codebuddy-capture-surfaces.md): the history tree
 * polled by `live.ts` — one immutable file per message plus a manifest — with
 * token counts joined from the agent's own per-day log, plus the
 * CC-compatible hooks that `install.ts` wires into `~/.codebuddy/settings.json`
 * for SessionStart, UserPromptSubmit, PostToolUse (the re-spawn heartbeat this
 * host actually fires) and SessionEnd (never observed — the listener ends
 * itself on idle).
 *
 * Product-agnostic machinery (shipping, disk queue, liveness, sweep, summary
 * fold) comes from `@slopwatch/listener-shared`; everything aware of this
 * host's layout lives here.
 */
export { createCodebuddyCapture, type CaptureState } from "./capture";
export { AGENT, PROVIDER, newTailState, normalizeMessage } from "./normalizer";
export { planHook } from "./hook";
export {
  HOOK_EVENTS,
  codebuddyProjectSettingsPath,
  codebuddyUserSettingsPath,
  mergeHookConfig,
  removeHookConfig,
  slopwatchHookCommand,
} from "./install";
export {
  conversationFromTranscriptPath,
  resolveSurfaces,
  usageLogPath,
  workspaceHash,
  workspaceMap,
} from "./paths";
export {
  indexUsageByMessage,
  usageFromLogText,
  USAGE_GRACE_MS,
  type UsageRecord,
} from "./usage";
export {
  parseConversationIndex,
  parseMessageFile,
  parseWorkspaceIndex,
  type CapturedMessage,
  type ConversationIndex,
} from "./transcript";
