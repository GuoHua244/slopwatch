/**
 * `slopwatch pause` / `slopwatch resume`: flip the capture kill switch in
 * the central config. Paused, the spawner exits before spawning anything,
 * so a half-finished deployment costs nothing — no listener, no events, no
 * summary tokens. Wiring stays in place; resume re-enables on the next
 * message. A listener already running when pause lands finishes its session
 * (one last end + summary) and is not replaced.
 */
import { loadConfig, saveConfig } from "@slopwatch/config";

export type PauseResult = { ok: boolean; lines: string[] };

export const setCapturePaused = (
  paused: boolean,
  homeDir?: string,
): PauseResult => {
  const config = loadConfig(homeDir);
  if (!config) {
    return {
      ok: false,
      lines: ["no slopwatch config — run `slopwatch install` first"],
    };
  }
  if (Boolean(config.disabled) === paused) {
    return {
      ok: true,
      lines: [
        paused
          ? "already paused — hooks fire but spawn nothing, no tokens spent"
          : "already running — capture is on",
      ],
    };
  }
  saveConfig({ ...config, disabled: paused }, homeDir);
  return {
    ok: true,
    lines: [
      paused
        ? "paused — hooks stay wired but spawn nothing; `slopwatch resume` turns capture back on"
        : "resumed — the next message in any wired project captures again",
    ],
  };
};
