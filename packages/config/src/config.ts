/**
 * The on-machine Slopwatch config: backend URL, bearer token, and the
 * optional LLM summary block. Lives at `~/.slopwatch/config.json` (0600) —
 * the single credential store the install flow writes and the hooks/listeners
 * read at fire time, so tokens never sit in per-project hook command lines.
 * `SLOPWATCH_HOME` (or the homeDir parameter) relocates the directory for
 * tests; a missing or unreadable file loads as null so capture falls back to
 * stdout mode instead of crashing a hook.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SummaryConfig = {
  /** OpenAI-compatible base URL, e.g. "https://llm-gateway.internal/v1". */
  endpoint: string;
  model: string;
  apiKey: string;
};

export type SlopwatchConfig = {
  serverUrl: string;
  token: string;
  summary?: SummaryConfig;
  /** Capture kill switch (`slopwatch pause`): true = hooks fire but the
   * spawner spawns nothing, so a half-finished deployment costs nothing. */
  disabled?: boolean;
};

/** The argv-shaped server-url/token pair hook entrypoints receive. */
export type ShipArgv = { serverUrl?: string; token?: string };

export const configFilePath = (homeDir?: string): string =>
  join(
    homeDir ?? process.env.SLOPWATCH_HOME ?? homedir(),
    ".slopwatch",
    "config.json",
  );

const isFilled = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isSummary = (value: unknown): value is SummaryConfig =>
  typeof value === "object" &&
  value !== null &&
  isFilled((value as Record<string, unknown>).endpoint) &&
  isFilled((value as Record<string, unknown>).model) &&
  isFilled((value as Record<string, unknown>).apiKey);

export const loadConfig = (homeDir?: string): SlopwatchConfig | null => {
  const path = configFilePath(homeDir);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // a missing file is fine (stdout mode); an existing one that cannot be
    // parsed is not — silently degrading would look exactly like a broken
    // install, so make it visible
    if (existsSync(path)) {
      console.error("slopwatch config file is corrupt and was ignored:", path);
    }
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (!isFilled(c.serverUrl) || !isFilled(c.token)) return null;
  const config: SlopwatchConfig = { serverUrl: c.serverUrl, token: c.token };
  if (isSummary(c.summary)) config.summary = c.summary;
  if (c.disabled === true) config.disabled = true;
  return config;
};

export const saveConfig = (config: SlopwatchConfig, homeDir?: string): void => {
  const path = configFilePath(homeDir);
  mkdirSync(join(path, ".."), { recursive: true });
  // mode 0600 at creation: the file carries the bearer token, so it must
  // never window in world-readable (chmod alone leaves a creation gap and is
  // a no-op on Windows anyway).
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows chmod only toggles the read-only bit — best effort.
  }
};

/**
 * Where to ship events: a complete argv pair wins (standalone/manual runs),
 * otherwise the central config, otherwise null (stdout mode). A partial argv
 * pair falls back wholesale — hooks never mix an argv URL with a stored token.
 */
export const resolveShipConfig = (
  argv: ShipArgv,
  homeDir?: string,
): { serverUrl: string; token: string } | null => {
  if (isFilled(argv.serverUrl) && isFilled(argv.token)) {
    return { serverUrl: argv.serverUrl, token: argv.token };
  }
  const config = loadConfig(homeDir);
  return config ? { serverUrl: config.serverUrl, token: config.token } : null;
};

/** Safe-to-print copy for install/status output. */
export const redactConfig = (config: SlopwatchConfig): SlopwatchConfig => {
  const mask = (value: string): string =>
    value.length <= 4 ? "…" : `${value.slice(0, 4)}…`;
  return {
    ...config,
    token: mask(config.token),
    ...(config.summary
      ? { summary: { ...config.summary, apiKey: mask(config.summary.apiKey) } }
      : {}),
  };
};
