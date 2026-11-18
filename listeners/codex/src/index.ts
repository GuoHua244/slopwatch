/**
 * @slopwatch/listener-codex — the per-session capture listener for OpenAI
 * Codex CLI / Codex Desktop.
 *
 * Capture surfaces (listeners/codex/SPEC.md, machine-verified against
 * codex-cli 0.147.0 + Codex Desktop 0.169.0-alpha rollouts): the rollout
 * JSONL at `<CODEX_HOME|~/.codex>/sessions/YYYY/MM/DD/rollout-*.jsonl`
 * tailed by `live.ts`, spawned by the Codex hooks system (`hooks.json`,
 * stable since ≤ 0.147.0) via `hook.ts`. SessionEnd exists and fires after
 * the rollout is flushed, so ends are real; idle/max-lifetime are the
 * fallback. Subagent threads are separate rollout files sharing the root
 * session id — claimed by the parent's childTails discovery.
 */
export { childSessionMarkers, createCodexAdapter } from "./adapter";
export {
  driftFromRecord,
  eventsFromRecord,
  newTailState,
  realUserPrompt,
  sessionIdFromFilename,
} from "./normalizer";
