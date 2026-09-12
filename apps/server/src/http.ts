import {
  isNormalEvent,
  SCHEMA_VERSION,
  type NormalEvent,
} from "@slopwatch/events";
import { existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import {
  NoSuchTeamError,
  TeamExistsError,
  UserExistsError,
  type Store,
} from "./store";
import {
  SETTING_KEYS,
  loadWebhookConfig,
  postWebhook,
  pushSessionEnds,
  webhookBody,
} from "./webhook";

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

const bearerToken = (req: Request): string | null => {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
};

/** Parse a JSON body, or null when it is not an object-shaped JSON payload. */
const readJson = async (
  req: Request,
): Promise<Record<string, unknown> | null> => {
  try {
    const body: unknown = await req.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** A trimmed string field within maxLen, or null when absent/oversized. */
const trimField = (value: unknown, maxLen: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLen ? trimmed : null;
};

/** Positive int query param clamped to 1..max; fallback when absent/garbage. */
const windowParam = (
  raw: string | null,
  max: number,
  fallback: number,
): number => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
};

export const createApp = ({
  tokens,
  store,
  staticRoot,
  adminToken,
}: AppOptions): App => ({
  async fetch(req) {
    const url = new URL(req.url);

    // Env tokens first (v0 bootstrap), then admin-minted tokens (decision 6).
    const resolveUser = async (): Promise<string | null> => {
      const bearer = bearerToken(req);
      if (bearer === null) return null;
      return tokens.get(bearer) ?? (await store.resolveTokenUser(bearer));
    };

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
      const user = await resolveUser();
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
      // v2 decision 25: finished sessions push to the org webhook —
      // fire-and-forget, never part of the ingest response
      pushSessionEnds(store, events, user);
      return json(202, { accepted });
    }

    // --- Read plane (v2 decision 22, ADR 0003): every read requires a
    // bearer token — an intranet visitor must never read prompt payloads.
    // /healthz above stays anonymous as the ops probe. ---
    const eventsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/events$/);
    if (eventsMatch && req.method === "GET") {
      const user = await resolveUser();
      if (user === null) return json(401, { error: "unauthorized" });
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
      const user = await resolveUser();
      if (user === null) return json(401, { error: "unauthorized" });
      return json(200, { sessions: await store.listSessions() });
    }

    // Decision 18: per-developer usage rollups (org-wide read like /sessions).
    if (url.pathname === "/rollups" && req.method === "GET") {
      const user = await resolveUser();
      if (user === null) return json(401, { error: "unauthorized" });
      const days = windowParam(url.searchParams.get("days"), 3650, 30);
      const hours = windowParam(url.searchParams.get("hours"), 168, 24);
      const now = Date.now();
      const sinceDay = new Date(now - (days - 1) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const sinceHour = new Date(now - (hours - 1) * 3_600_000)
        .toISOString()
        .slice(0, 13);
      return json(200, await store.listRollups(sinceDay, sinceHour));
    }

    // v2 decision 23: the roster, for the leaderboard's team grouping.
    if (url.pathname === "/teams" && req.method === "GET") {
      const user = await resolveUser();
      if (user === null) return json(401, { error: "unauthorized" });
      return json(200, { teams: await store.teamsWithMembers() });
    }

    // --- Review plane (decision 10): reads are org-wide for token holders;
    // writes carry the reader's user token; the review marker itself is
    // DRI-exclusive. ---
    if (url.pathname === "/me" && req.method === "GET") {
      const user = await resolveUser();
      if (user === null) return json(401, { error: "unauthorized" });
      return json(200, { user, is_dri: await store.isDri(user) });
    }

    const reviewMatch = url.pathname.match(/^\/sessions\/([^/]+)\/review$/);
    if (reviewMatch) {
      const sessionId = decodeURIComponent(reviewMatch[1]!);
      if (req.method === "GET") {
        const user = await resolveUser();
        if (user === null) return json(401, { error: "unauthorized" });
        return json(200, { review: await store.reviewFor(sessionId) });
      }
      if (req.method === "POST" || req.method === "DELETE") {
        const user = await resolveUser();
        if (user === null) return json(401, { error: "unauthorized" });
        if (!(await store.isDri(user)))
          return json(403, { error: "only a DRI can change review state" });
        if (req.method === "POST") {
          const review = await store.markReviewed(sessionId, user);
          return review === null
            ? json(404, { error: "no such session" })
            : json(200, { review });
        }
        return (await store.unmarkReviewed(sessionId))
          ? new Response(null, { status: 204 })
          : json(404, { error: "no such review" });
      }
    }

    const commentsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/comments$/);
    if (commentsMatch) {
      const sessionId = decodeURIComponent(commentsMatch[1]!);
      if (req.method === "GET") {
        const user = await resolveUser();
        if (user === null) return json(401, { error: "unauthorized" });
        return json(200, { comments: await store.listComments(sessionId) });
      }
      if (req.method === "POST") {
        const user = await resolveUser();
        if (user === null) return json(401, { error: "unauthorized" });
        const body = await readJson(req);
        if (body === null) return json(400, { error: "invalid json" });
        const note = trimField(body.body, 4000);
        if (note === null)
          return json(400, { error: "body must be a non-empty string" });
        const turnId = trimField(body.turn_id, 200);
        const comment = await store.addComment(sessionId, turnId, user, note);
        return comment === null
          ? json(404, { error: "no such session" })
          : json(201, { comment });
      }
    }

    // --- Admin plane (decision 13). Disabled unless SLOPWATCH_ADMIN_TOKEN is set.
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      if (adminToken === undefined)
        return json(404, { error: "admin plane disabled" });
      if (bearerToken(req) !== adminToken)
        return json(401, { error: "unauthorized" });

      if (url.pathname === "/admin/health" && req.method === "GET")
        return json(200, { ok: true, ...(await store.health()) });

      // v2 decision 21: inspect the quarantine — the verbatim drift evidence.
      if (url.pathname === "/admin/quarantine" && req.method === "GET") {
        const limit = windowParam(url.searchParams.get("limit"), 500, 50);
        return json(200, { rows: await store.listQuarantine(limit) });
      }

      // v2 decision 23: team management.
      if (url.pathname === "/admin/teams") {
        if (req.method === "GET")
          return json(200, { teams: await store.listTeams() });
        if (req.method === "POST") {
          const body = await readJson(req);
          if (body === null) return json(400, { error: "invalid json" });
          const name = trimField(body.name, 100);
          if (name === null)
            return json(400, { error: "name must be a non-empty string" });
          let retention: number | null = null;
          if (body.raw_retention_days !== undefined) {
            if (
              body.raw_retention_days !== null &&
              (typeof body.raw_retention_days !== "number" ||
                !Number.isInteger(body.raw_retention_days) ||
                body.raw_retention_days < 1)
            ) {
              return json(400, {
                error: "raw_retention_days must be null or a positive integer",
              });
            }
            retention = body.raw_retention_days;
          }
          try {
            return json(201, { team: await store.createTeam(name, retention) });
          } catch (e) {
            if (e instanceof TeamExistsError)
              return json(409, { error: e.message });
            throw e;
          }
        }
      }

      const teamMatch = url.pathname.match(/^\/admin\/teams\/([^/]+)$/);
      if (teamMatch) {
        const id = decodeURIComponent(teamMatch[1]!);
        if (req.method === "PATCH") {
          const body = await readJson(req);
          if (body === null) return json(400, { error: "invalid json" });
          const { name, raw_retention_days } = body;
          if (name !== undefined && trimField(name, 100) === null)
            return json(400, { error: "name must be a non-empty string" });
          if (
            raw_retention_days !== undefined &&
            raw_retention_days !== null &&
            (typeof raw_retention_days !== "number" ||
              !Number.isInteger(raw_retention_days) ||
              raw_retention_days < 1)
          ) {
            return json(400, {
              error: "raw_retention_days must be null or a positive integer",
            });
          }
          if (name === undefined && raw_retention_days === undefined)
            return json(400, { error: "nothing to update" });
          try {
            const team = await store.updateTeam(id, {
              ...(name !== undefined ? { name: trimField(name, 100)! } : {}),
              ...(raw_retention_days !== undefined
                ? { raw_retention_days }
                : {}),
            });
            return team === null
              ? json(404, { error: "no such team" })
              : json(200, { team });
          } catch (e) {
            if (e instanceof TeamExistsError)
              return json(409, { error: e.message });
            throw e;
          }
        }
        if (req.method === "DELETE") {
          return (await store.deleteTeam(id))
            ? json(200, { ok: true })
            : json(404, { error: "no such team" });
        }
      }

      if (url.pathname === "/admin/users") {
        if (req.method === "GET")
          return json(200, { users: await store.listUsers() });
        if (req.method === "POST") {
          const body = await readJson(req);
          if (body === null) return json(400, { error: "invalid json" });
          const name = trimField(body.name, 100);
          const email = trimField(body.email, 200);
          if (name === null)
            return json(400, { error: "name must be a non-empty string" });
          try {
            return json(201, { user: await store.createUser(name, email) });
          } catch (e) {
            if (e instanceof UserExistsError)
              return json(409, { error: e.message });
            throw e;
          }
        }
      }

      const userMatch = url.pathname.match(/^\/admin\/users\/([^/]+)$/);
      if (userMatch) {
        const name = decodeURIComponent(userMatch[1]!);
        if (req.method === "PATCH") {
          const body = await readJson(req);
          if (body === null) return json(400, { error: "invalid json" });
          const { disabled, is_dri, team_id } = body;
          if (disabled !== undefined && typeof disabled !== "boolean")
            return json(400, { error: "disabled must be a boolean" });
          if (is_dri !== undefined && typeof is_dri !== "boolean")
            return json(400, { error: "is_dri must be a boolean" });
          if (
            team_id !== undefined &&
            team_id !== null &&
            typeof team_id !== "string"
          )
            return json(400, { error: "team_id must be a string or null" });
          if (
            disabled === undefined &&
            is_dri === undefined &&
            team_id === undefined
          ) {
            return json(400, { error: "nothing to update" });
          }
          try {
            if (disabled !== undefined) {
              const user = await store.setUserDisabled(name, disabled);
              if (user === null) return json(404, { error: "no such user" });
            }
            if (is_dri !== undefined) {
              const user = await store.setUserDri(name, is_dri);
              if (user === null) return json(404, { error: "no such user" });
            }
            if (team_id !== undefined) {
              const user = await store.setUserTeam(name, team_id);
              if (user === null) return json(404, { error: "no such user" });
            }
          } catch (e) {
            if (e instanceof NoSuchTeamError)
              return json(404, { error: e.message });
            throw e;
          }
          return json(200, { user: await store.getUser(name) });
        }
        if (req.method === "DELETE") {
          return (await store.deleteUser(name))
            ? json(200, { ok: true })
            : json(404, { error: "no such user" });
        }
      }

      const tokensMatch = url.pathname.match(
        /^\/admin\/users\/([^/]+)\/tokens$/,
      );
      if (tokensMatch) {
        const name = decodeURIComponent(tokensMatch[1]!);
        if ((await store.getUser(name)) === null)
          return json(404, { error: "no such user" });
        if (req.method === "POST")
          return json(201, await store.mintToken(name));
        if (req.method === "GET")
          return json(200, { tokens: await store.listTokens(name) });
      }

      const tokenMatch = url.pathname.match(/^\/admin\/tokens\/([^/]+)$/);
      if (tokenMatch && req.method === "DELETE") {
        // Malformed (non-UUID) ids must 404, not surface a Postgres cast error.
        try {
          return (await store.revokeToken(decodeURIComponent(tokenMatch[1]!)))
            ? json(200, { ok: true })
            : json(404, { error: "no such token" });
        } catch {
          return json(404, { error: "no such token" });
        }
      }

      // v2 decision 25: operator settings + a webhook test push.
      if (url.pathname === "/admin/settings") {
        if (req.method === "GET")
          return json(200, { settings: await store.listSettings() });
        if (req.method === "PUT") {
          const body = await readJson(req);
          if (body === null) return json(400, { error: "invalid json" });
          for (const [key, value] of Object.entries(body)) {
            if (!(SETTING_KEYS as readonly string[]).includes(key))
              return json(400, { error: `unknown setting ${key}` });
            if (key === "webhook_url" && value !== null) {
              if (typeof value !== "string" || value.length > 1000)
                return json(400, { error: "webhook_url must be a string" });
              try {
                const parsed = new URL(value);
                if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
                  return json(400, { error: "webhook_url must be http(s)" });
              } catch {
                return json(400, { error: "webhook_url must be a valid URL" });
              }
            }
            if (
              key === "webhook_enabled" &&
              value !== "true" &&
              value !== "false"
            )
              return json(400, {
                error: 'webhook_enabled must be "true" or "false"',
              });
            if (key === "webhook_format") {
              if (
                typeof value !== "string" ||
                !["slack", "feishu", "dingtalk"].includes(value)
              )
                return json(400, {
                  error: "webhook_format must be slack, feishu, or dingtalk",
                });
            }
          }
          for (const [key, value] of Object.entries(body)) {
            if (value === null || value === undefined) continue;
            await store.setSetting(key, String(value));
          }
          return json(200, { settings: await store.listSettings() });
        }
      }

      if (url.pathname === "/admin/webhook/test" && req.method === "POST") {
        const cfg = await loadWebhookConfig(store);
        if (cfg === null)
          return json(400, { error: "webhook is not configured" });
        try {
          await postWebhook(
            cfg.url,
            webhookBody(cfg.format, "slopwatch webhook test — delivery works"),
          );
          return json(200, { ok: true, format: cfg.format });
        } catch (e) {
          return json(502, {
            error: `webhook delivery failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          });
        }
      }

      const sessionMatch = url.pathname.match(/^\/admin\/sessions\/([^/]+)$/);
      if (sessionMatch && req.method === "DELETE") {
        return (await store.deleteSession(decodeURIComponent(sessionMatch[1]!)))
          ? json(200, { ok: true })
          : json(404, { error: "no such session" });
      }
    }

    // Exact-name static assets after the API routes — unknown paths still 404.
    if (staticRoot && (req.method === "GET" || req.method === "HEAD")) {
      const file = staticFile(staticRoot, url.pathname);
      if (file) return staticResponse(file, req.method);
    }

    return json(404, { error: "not found" });
  },
});
