import {
  isNormalEvent,
  SCHEMA_VERSION,
  type NormalEvent,
} from "@slopwatch/events";
import { existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type { Store } from "./store";

export type App = { fetch: (req: Request) => Promise<Response> };

export type AppOptions = {
  /** bearer token → user name (v0: from env; later: admin-minted, decision 6). */
  tokens: Map<string, string>;
  store: Store;
  /**
   * Directory of the built dashboard (apps/web/dist) served same-origin
   * (decision 12). Absent or unbuilt, GET / answers 503 with a build hint.
   */
  staticRoot?: string;
  /** Admin plane bearer token (decision 13). Unset disables /admin/*. */
  adminToken?: string;
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const text = (status: number, body: string): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

const CONTENT_TYPES: Record<string, string> = {
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
const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * Resolve a URL pathname inside staticRoot, or null when it escapes the root
 * or names no existing file. Callers turn null into 404 — no catch-all.
 */
const staticFile = (
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

const staticResponse = (
  file: { path: string; contentType: string; isEntry: boolean },
  method: string,
): Response =>
  new Response(method === "HEAD" ? null : Bun.file(file.path), {
    headers: {
      "content-type": file.contentType,
      "cache-control": file.isEntry ? "no-cache" : ASSET_CACHE_CONTROL,
    },
  });

const identify = (req: Request, tokens: Map<string, string>): string | null => {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return tokens.get(header.slice("Bearer ".length).trim()) ?? null;
};

export const createApp = ({
  tokens,
  store,
  staticRoot,
  adminToken,
}: AppOptions): App => ({
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") return json(200, { ok: true });

    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (staticRoot && (req.method === "GET" || req.method === "HEAD")) {
        const file = staticFile(staticRoot, "/index.html");
        if (file) return staticResponse(file, req.method);
      }
      if (req.method === "GET" || req.method === "HEAD") {
        return text(
          503,
          "slopwatch dashboard is not built yet — run `bun run build` first",
        );
      }
    }

    if (url.pathname === "/events" && req.method === "POST") {
      const user = identify(req, tokens);
      if (user === null) return json(401, { error: "unauthorized" });

      let body: { schema_version?: number; events?: unknown[] };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json(400, { error: "invalid json" });
      }
      if (body.schema_version !== SCHEMA_VERSION) {
        return json(400, {
          error: `expected schema_version ${SCHEMA_VERSION}`,
        });
      }
      if (!Array.isArray(body.events))
        return json(400, { error: "events must be an array" });
      const events: NormalEvent[] = [];
      for (const [i, candidate] of body.events.entries()) {
        if (!isNormalEvent(candidate)) {
          return json(400, { error: `event at index ${i} failed validation` });
        }
        events.push(candidate);
      }
      const { accepted } = await store.appendEvents(events, user);
      return json(202, { accepted });
    }

    const eventsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/events$/);
    if (eventsMatch && req.method === "GET") {
      const sinceSeq = Number(url.searchParams.get("since_seq") ?? 0);
      const events = await store.eventsSince(
        decodeURIComponent(eventsMatch[1]!),
        Number.isFinite(sinceSeq) && sinceSeq >= 0 ? sinceSeq : 0,
      );
      return json(200, {
        session_id: decodeURIComponent(eventsMatch[1]!),
        events,
      });
    }

    if (url.pathname === "/sessions" && req.method === "GET") {
      return json(200, { sessions: await store.listSessions() });
    }

    // Exact-name static assets after the API routes — unknown paths still 404.
    if (staticRoot && (req.method === "GET" || req.method === "HEAD")) {
      const file = staticFile(staticRoot, url.pathname);
      if (file) return staticResponse(file, req.method);
    }

    return json(404, { error: "not found" });
  },
});
