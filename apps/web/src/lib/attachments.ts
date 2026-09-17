import { storedToken } from "../auth";

/**
 * Authed image loading for the turn view: <img> tags cannot carry an
 * Authorization header, so each attachment is fetched with the browser's
 * bearer token and turned into an object URL. URLs are cached by
 * session+sha forever — the bytes are content-addressed and immutable, and
 * object URLs live for the page's lifetime anyway.
 */
const urlCache = new Map<string, string>();

export const attachmentUrl = async (
  sessionId: string,
  sha256: string,
): Promise<string | null> => {
  const key = `${sessionId}/${sha256}`;
  const hit = urlCache.get(key);
  if (hit !== undefined) return hit;
  try {
    const token = storedToken();
    const res = await fetch(
      `/sessions/${encodeURIComponent(sessionId)}/attachments/${sha256}`,
      token !== null ? { headers: { authorization: `Bearer ${token}` } } : {},
    );
    if (!res.ok) return null;
    const url = URL.createObjectURL(await res.blob());
    urlCache.set(key, url);
    return url;
  } catch {
    return null;
  }
};
