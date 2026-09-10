/**
 * `slopwatch login <token>`: verify a token against the Server, then store
 * it in the central config. Nothing is written when verification fails —
 * a bad token must never replace a working one.
 */
import { loadConfig, saveConfig } from "@slopwatch/config";
import { verifyToken } from "./verify";

export type LoginResult =
  | { ok: true; user: string; isDri: boolean; serverUrl: string }
  | { ok: false; error: string };

export const login = async (opts: {
  token: string;
  serverUrl?: string;
  homeDir?: string;
  fetchImpl?: typeof fetch;
}): Promise<LoginResult> => {
  const existing = loadConfig(opts.homeDir);
  const serverUrl =
    opts.serverUrl ?? existing?.serverUrl ?? "http://localhost:8787";
  const verdict = await verifyToken(serverUrl, opts.token, opts.fetchImpl);
  if (!verdict.ok) {
    return { ok: false, error: `${verdict.error} — nothing written` };
  }
  saveConfig({ ...existing, serverUrl, token: opts.token }, opts.homeDir);
  return { ok: true, user: verdict.user, isDri: verdict.isDri, serverUrl };
};
