import { existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

export const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// Vite emits content-hashed asset names, so they can be cached forever; the
// entry HTML is the staleness boundary and must revalidate.
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * Resolve a URL pathname inside staticRoot, or null when it escapes the root
 * or names no existing file. Callers turn null into 404 — no catch-all.
 */
export const staticFile = (
  staticRoot: string,
  pathname: string,
): { path: string; contentType: string; isEntry: boolean } | null => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const root = resolve(staticRoot);
  const target = resolve(root, `.${decoded}`);
  if (target !== root && !target.startsWith(root + sep)) return null;
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  const isEntry = target === resolve(root, "index.html");
  return {
    path: target,
    isEntry,
    contentType:
      CONTENT_TYPES[extname(target).toLowerCase()] ??
      "application/octet-stream",
  };
};

export const staticResponse = (
  file: { path: string; contentType: string; isEntry: boolean },
  method: string,
): Response =>
  new Response(method === "HEAD" ? null : Bun.file(file.path), {
    headers: {
      "content-type": file.contentType,
      "cache-control": file.isEntry ? "no-cache" : ASSET_CACHE_CONTROL,
    },
  });
