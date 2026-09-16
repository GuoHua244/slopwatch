/**
 * Verify a bearer token against the Server's authenticated `GET /me`
 * endpoint before anything is written to disk — a mistyped or revoked
 * token must fail loudly at install/login time, not silently at capture
 * time.
 */
import { joinUrl } from "@slopwatch/events";

export type VerifyResult =
  | { ok: true; user: string; isDri: boolean }
  | { ok: false; error: string };

export const verifyToken = async (
  serverUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> => {
  let res: Response;
  try {
    res = await fetchImpl(joinUrl(serverUrl, "/me"), {
      headers: { authorization: `Bearer ${token}` },
      // a hung server must not hang the interactive install/login forever
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return {
      ok: false,
      error: `server unreachable at ${serverUrl} (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  if (res.status === 401) {
    return { ok: false, error: "the server rejected this token (401)" };
  }
  if (!res.ok) {
    return { ok: false, error: `the server responded ${res.status}` };
  }
  const body = (await res.json().catch(() => null)) as {
    user?: unknown;
    is_dri?: unknown;
  } | null;
  if (!body || typeof body.user !== "string" || body.user.length === 0) {
    return { ok: false, error: "unexpected /me response shape" };
  }
  return { ok: true, user: body.user, isDri: body.is_dri === true };
};
