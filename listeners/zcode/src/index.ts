/**
 * @slopwatch/listener-zcode — the per-session capture sidecar for ZCode.
 *
 * Capture surfaces (research/coding-agent-ingestion.md, "ZCode"): the rollout
 * JSONL at `<zcodeHome>/cli/rollout/model-io-<sessionId>.jsonl` (one record per
 * model request, including subagent sessions) tailed by `live.ts`, with the
 * `SessionStart` hook spawning it via `spawner.ts`. ZCode has no SessionEnd
 * hook, so the sidecar exits on idle timeout (plus a max-lifetime cap).
 */
export {
  eventsFromRecord,
  resolveSessionId,
  sessionIdFromFilename,
} from "./normalizer";
