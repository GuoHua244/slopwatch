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
  type AuditActor,
  type Role,
  type Store,
} from "./store";
import {
  SETTING_KEYS,
  loadWebhookConfig,
  postWebhook,
  pushSessionEnds,
  webhookBody,
} from "./webhook";
import type { OidcVerifier } from "./oidc";

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
  /**
   * Operator bypass bearer for the admin plane (decision 13). Optional and
   * no longer the only way in: a signed-in user with the admin role passes
   * the same gate. Unset simply removes the bypass.
   */
  adminToken?: string;
  /**
   * The raw-TTL default the settings plane falls back to when the operator
   * has not stored an override (the env RAW_TTL_DAYS at boot).
   */
  defaultRawTtlDays?: number;
  /**
   * The S3-compatible cold archive (v2 decision 21). Present, GET
   * /admin/archive can fetch an archived raw payload back by key; absent the
   * route answers 400.
   */
  archive?: { getObject(key: string): Promise<string> };
  /**
   * ADR 0005: the org IdP as a second token issuer. Present, an RS256 bearer
   * JWT it signs resolves to a user alongside minted tokens; absent, minted
   * tokens only.
   */
  oidc?: OidcVerifier;
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

/** Team retention override (decision 23): absent passes through, null inherits
 * the global default, otherwise a positive integer. */
const isRetention = (value: unknown): value is number | null | undefined =>
  value === undefined ||
  value === null ||
  (typeof value === "number" && Number.isInteger(value) && value >= 1);
const RETENTION_ERROR = "raw_retention_days must be null or a positive integer";

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

/** Per-field before/after for an audit diff; unchanged fields drop out. */
const diffFields = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: readonly string[],
): Record<string, { before: unknown; after: unknown }> => {
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const field of fields) {
    if (before[field] !== after[field])
      changes[field] = {
        before: before[field] ?? null,
        after: after[field] ?? null,
      };
  }
  return changes;
};

export const createApp = ({
  tokens,
  store,
  staticRoot,
  adminToken,
  defaultRawTtlDays = 90,
  archive,
  oidc,
}: AppOptions): App => ({
  async fetch(req) {
    const url = new URL(req.url);

    // Env tokens first (v0 bootstrap), then admin-minted tokens (decision 6),
    // then IdP-issued JWTs (ADR 0005).
    const resolveUser = async (): Promise<string | null> => {
      const bearer = bearerToken(req);
      if (bearer === null) return null;
      const minted =
        tokens.get(bearer) ?? (await store.resolveTokenUser(bearer));
      if (minted !== null) return minted;
      const identity = oidc === undefined ? null : await oidc.verify(bearer);
      if (identity === null) return null;
      return store.resolveOidcUser(identity);
    };

    // The signed-in reader plus their authorization role. Role-based reads:
    // members see only their own rows; admins see the org (decision: role
    // plane). One extra primary-key lookup per read is the whole cost.
    const resolveReader = async (): Promise<{
      user: string;
      role: Role;
    } | null> => {
      const user = await resolveUser();
      if (user === null) return null;
      return { user, role: await store.roleOf(user) };
    };

    // ADR 0007: every successful mutation leaves one audit entry. Best-effort
    // by design — the change has already committed, so a failed append must
    // not fail the response and tempt a retry of a non-idempotent operation.
    const audit = (
      actor: AuditActor,
      action: string,
      target: string,
      detail?: Record<string, unknown>,
    ): Promise<void> =>
      store
        .appendAudit({ actor, action, target, detail })
        .catch((e: unknown) => console.error("audit append failed:", e));

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
      const reader = await resolveReader();
      if (reader === null) return json(401, { error: "unauthorized" });
      const sessionId = decodeURIComponent(eventsMatch[1]!);
      // Members may only read their own sessions' payloads; a foreign or
      // unknown id answers 404 so existence never leaks across users.
      if (reader.role !== "admin") {
        const owner = await store.sessionOwner(sessionId);
        if (owner !== reader.user)
          return json(404, { error: "no such session" });
      }
      const sinceSeq = Number(url.searchParams.get("since_seq") ?? 0);
      const events = await store.eventsSince(
        sessionId,
        Number.isFinite(sinceSeq) && sinceSeq >= 0 ? sinceSeq : 0,
      );
      return json(200, { session_id: sessionId, events });
    }

    if (url.pathname === "/sessions" && req.method === "GET") {
      const reader = await resolveReader();
      if (reader === null) return json(401, { error: "unauthorized" });
      // Team-scoped DRI filter: "unassigned" is the NULL-team bucket. Members
      // are always scoped to their own sessions regardless of the filter.
      const teamId = url.searchParams.get("team_id")?.trim() || undefined;
      return json(200, {
        sessions: await store.listSessions(
          teamId,
          reader.role === "admin" ? undefined : reader.user,
        ),
      });
    }

    // Decision 18: per-developer usage rollups. Admins read org-wide (the
    // leaderboard); members only ever receive their own rows.
    if (url.pathname === "/rollups" && req.method === "GET") {
      const reader = await resolveReader();
      if (reader === null) return json(401, { error: "unauthorized" });
      const days = windowParam(url.searchParams.get("days"), 3650, 30);
      // hourly ceiling = 31 days so the local-calendar-day charts (decision 27)
      // can re-bucket a full month of UTC hours
      const hours = windowParam(url.searchParams.get("hours"), 31 * 24, 24);
      const teamId = url.searchParams.get("team_id") ?? undefined;
      const now = Date.now();
      const sinceDay = new Date(now - (days - 1) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const sinceHour = new Date(now - (hours - 1) * 3_600_000)
        .toISOString()
        .slice(0, 13);
      return json(
        200,
        await store.listRollups(
          sinceDay,
          sinceHour,
          teamId,
          reader.role === "admin" ? undefined : reader.user,
        ),
      );
    }

    // v2 decision 23: the roster, for the leaderboard's team grouping.
    if (url.pathname === "/teams" && req.method === "GET") {
      const user = await resolveUser();
      if (user === null) return json(401, { error: "unauthorized" });
      return json(200, { teams: await store.teamsWithMembers() });
    }

    // --- Read-plane identity: GET /me — the signed-in user plus their
    // lifetime footprint, the one payload the profile page needs. First
    // sight also provisions the users row, so env-token users become
    // manageable by role and team without a manual create. ---
    if (url.pathname === "/me" && req.method === "GET") {
      const reader = await resolveReader();
      if (reader === null) return json(401, { error: "unauthorized" });
      if (await store.ensureUser(reader.user)) {
        // ADR 0007: first sight provisioned the row — that is a user
        // appearing in the org, so the trail records it.
        await audit(
          { kind: "user", user: reader.user },
          "user.provision",
          reader.user,
          { via: "sign-in" },
        );
      }
      const row = await store.getUser(reader.user);
      return json(200, {
        user: reader.user,
        role: reader.role,
        email: row?.email ?? null,
        team_name: row?.team_name ?? null,
        is_dri: row?.is_dri ?? false,
        created_at: row?.created_at ?? null,
        usage: await store.ownUsage(reader.user),
      });
    }

    // --- Review plane (decision 10): reads are org-wide for token holders;
    // writes carry the reader's user token; the review marker itself is
    // DRI-exclusive. ---
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
          if (review !== null)
            await audit({ kind: "user", user }, "review.mark", sessionId);
          return review === null
            ? json(404, { error: "no such session" })
            : json(200, { review });
        }
        if (await store.unmarkReviewed(sessionId)) {
          await audit({ kind: "user", user }, "review.unmark", sessionId);
          return new Response(null, { status: 204 });
        }
        return json(404, { error: "no such review" });
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
        if (comment !== null) {
          await audit({ kind: "user", user }, "note.add", sessionId, {
            comment_id: comment.comment_id,
            turn_id: comment.turn_id,
          });
          return json(201, { comment });
        }
        return json(404, { error: "no such session" });
      }
    }

    // A note belongs to its author: they — and only they — may retract it.
    const commentMatch = url.pathname.match(
      /^\/sessions\/([^/]+)\/comments\/(\d+)$/,
    );
    if (commentMatch && req.method === "DELETE") {
      const user = await resolveUser();
      if (user === null) return json(401, { error: "unauthorized" });
      const sessionId = decodeURIComponent(commentMatch[1]!);
      const commentId = Number(commentMatch[2]);
      // ADR 0007: the retracted note vanishes — capture a preview first so
      // the trail says what was removed, not just that something was.
      const existing = await store.getComment(commentId);
      if (await store.deleteComment(commentId, user)) {
        await audit({ kind: "user", user }, "note.delete", sessionId, {
          comment_id: commentId,
          turn_id: existing?.turn_id ?? null,
          author: existing?.author_id ?? null,
          body_preview:
            existing === null
              ? null
              : existing.body.length > 140
                ? `${existing.body.slice(0, 140)}…`
                : existing.body,
        });
        return new Response(null, { status: 204 });
      }
      return json(404, { error: "no such note" });
    }

    // --- Admin plane (decision 13, now role-based): a signed-in user with
    // the admin role passes; SLOPWATCH_ADMIN_TOKEN stays as the operator
    // bypass for bootstrapping the first admin and break-glass access. ---
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      const bearer = bearerToken(req);
      // Null when the caller is the operator bypass — there is no user
      // identity to attribute, which only the self-role guard below cares
      // about.
      let caller: string | null = null;
      if (bearer === null) return json(401, { error: "unauthorized" });
      if (bearer !== adminToken) {
        const reader = await resolveReader();
        if (reader === null) return json(401, { error: "unauthorized" });
        if (reader.role !== "admin")
          return json(403, { error: "the admin role is required" });
        caller = reader.user;
      }
      // ADR 0007: every admin mutation is attributed to the signed-in admin,
      // or to the operator pseudo-actor on the break-glass bypass.
      const adminActor: AuditActor =
        caller === null ? { kind: "operator" } : { kind: "user", user: caller };

      if (url.pathname === "/admin/health" && req.method === "GET")
        return json(200, { ok: true, ...(await store.health()) });

      // ADR 0007: the audit trail read — newest first, filterable by action
      // category prefix and acting user, paginated with a filtered total.
      if (url.pathname === "/admin/audit" && req.method === "GET") {
        const limit = windowParam(url.searchParams.get("limit"), 200, 50);
        const offsetRaw = Number(url.searchParams.get("offset") ?? 0);
        return json(
          200,
          await store.listAudit({
            limit,
            offset:
              Number.isFinite(offsetRaw) && offsetRaw > 0
                ? Math.floor(offsetRaw)
                : 0,
            kind:
              url.searchParams.get("kind")?.trim().replace(/\.+$/, "") ||
              undefined,
            actor: url.searchParams.get("actor")?.trim() || undefined,
          }),
        );
      }

      // v2 decision 21: inspect the quarantine — the verbatim drift evidence.
      if (url.pathname === "/admin/quarantine" && req.method === "GET") {
        const limit = windowParam(url.searchParams.get("limit"), 500, 50);
        return json(200, { rows: await store.listQuarantine(limit) });
      }

      // v2 decision 21: fetch an archived raw payload back by key — the
      // retrieval half of archive-before-prune. Only keys this server writes
      // (raw/<agent>/<sessionId>/<seq>.json) are legal, so the cold store
      // stays unreachable outside that namespace.
      if (url.pathname === "/admin/archive" && req.method === "GET") {
        if (!archive) return json(400, { error: "archive is not configured" });
        const key = url.searchParams.get("key") ?? "";
        if (!/^raw\/[a-z0-9_-]+\/[a-z0-9_-]+\/\d+\.json$/.test(key))
          return json(400, { error: "bad archive key" });
        try {
          return new Response(await archive.getObject(key), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        } catch (e) {
          return json(502, {
            error: `archive fetch failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          });
        }
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
          if (!isRetention(body.raw_retention_days))
            return json(400, { error: RETENTION_ERROR });
          const retention = body.raw_retention_days ?? null;
          try {
            const team = await store.createTeam(name, retention);
            await audit(adminActor, "team.create", name, {
              id: team.id,
              raw_retention_days: retention,
            });
            return json(201, { team });
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
          if (!isRetention(raw_retention_days))
            return json(400, { error: RETENTION_ERROR });
          if (name === undefined && raw_retention_days === undefined)
            return json(400, { error: "nothing to update" });
          const before = await store.getTeam(id);
          try {
            const team = await store.updateTeam(id, {
              ...(name !== undefined ? { name: trimField(name, 100)! } : {}),
              ...(raw_retention_days !== undefined
                ? { raw_retention_days }
                : {}),
            });
            if (team === null) return json(404, { error: "no such team" });
            if (before !== null) {
              const changes = diffFields(
                {
                  name: before.name,
                  raw_retention_days: before.raw_retention_days,
                },
                {
                  name: team.name,
                  raw_retention_days: team.raw_retention_days,
                },
                ["name", "raw_retention_days"],
              );
              if (Object.keys(changes).length > 0)
                await audit(adminActor, "team.update", team.name, {
                  id,
                  changes,
                });
            }
            return json(200, { team });
          } catch (e) {
            if (e instanceof TeamExistsError)
              return json(409, { error: e.message });
            throw e;
          }
        }
        if (req.method === "DELETE") {
          const before = await store.getTeam(id);
          if (await store.deleteTeam(id)) {
            await audit(adminActor, "team.delete", before?.name ?? id, {
              id,
              member_count: before?.member_count ?? 0,
            });
            return json(200, { ok: true });
          }
          return json(404, { error: "no such team" });
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
            const user = await store.createUser(name, email);
            await audit(adminActor, "user.create", name, { email });
            return json(201, { user });
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
          const { disabled, is_dri, team_id, role } = body;
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
          if (role !== undefined && role !== "admin" && role !== "member")
            return json(400, { error: 'role must be "admin" or "member"' });
          // An admin who demotes themselves may strand the plane with no
          // admin left; changing your own role goes through another admin
          // (or the operator bypass).
          if (role !== undefined && role !== "admin" && caller === name)
            return json(400, { error: "cannot change your own role" });
          if (
            disabled === undefined &&
            is_dri === undefined &&
            team_id === undefined &&
            role === undefined
          ) {
            return json(400, { error: "nothing to update" });
          }
          const before = await store.getUser(name);
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
            if (role !== undefined) {
              const user = await store.setUserRole(name, role);
              if (user === null) return json(404, { error: "no such user" });
            }
          } catch (e) {
            if (e instanceof NoSuchTeamError)
              return json(404, { error: e.message });
            throw e;
          }
          const after = await store.getUser(name);
          if (before !== null && after !== null) {
            const changes = diffFields(
              {
                disabled: before.disabled,
                is_dri: before.is_dri,
                role: before.role,
                team: before.team_name,
              },
              {
                disabled: after.disabled,
                is_dri: after.is_dri,
                role: after.role,
                team: after.team_name,
              },
              ["disabled", "is_dri", "role", "team"],
            );
            if (Object.keys(changes).length > 0)
              await audit(adminActor, "user.update", name, { changes });
          }
          return json(200, { user: after });
        }
        if (req.method === "DELETE") {
          const before = await store.getUser(name);
          if (await store.deleteUser(name)) {
            await audit(
              adminActor,
              "user.delete",
              name,
              before === null
                ? {}
                : {
                    email: before.email,
                    team: before.team_name,
                    role: before.role,
                    active_tokens: before.active_tokens,
                  },
            );
            return json(200, { ok: true });
          }
          return json(404, { error: "no such user" });
        }
      }

      const tokensMatch = url.pathname.match(
        /^\/admin\/users\/([^/]+)\/tokens$/,
      );
      if (tokensMatch) {
        const name = decodeURIComponent(tokensMatch[1]!);
        if ((await store.getUser(name)) === null)
          return json(404, { error: "no such user" });
        if (req.method === "POST") {
          const minted = await store.mintToken(name);
          await audit(adminActor, "token.mint", name, {
            token_id: minted.token_id,
            hint: minted.hint,
          });
          return json(201, minted);
        }
        if (req.method === "GET")
          return json(200, { tokens: await store.listTokens(name) });
      }

      const tokenMatch = url.pathname.match(/^\/admin\/tokens\/([^/]+)$/);
      if (tokenMatch && req.method === "DELETE") {
        // Malformed (non-UUID) ids must 404, not surface a Postgres cast error.
        try {
          const id = decodeURIComponent(tokenMatch[1]!);
          const before = await store.getToken(id);
          if (await store.revokeToken(id)) {
            await audit(adminActor, "token.revoke", before?.user_name ?? id, {
              token_id: id,
              hint: before?.hint ?? null,
              user: before?.user_name ?? null,
            });
            return json(200, { ok: true });
          }
          return json(404, { error: "no such token" });
        } catch {
          return json(404, { error: "no such token" });
        }
      }

      // v2 decision 25, broadened: operator settings as their effective
      // values — stored overrides merged over the boot defaults, so the
      // settings page shows what the server actually does, not just what was
      // explicitly saved.
      if (url.pathname === "/admin/settings") {
        // Stored overrides merged over the boot defaults — both GET and the
        // PUT answer show what the server actually does.
        const effective = async (): Promise<Record<string, string>> => {
          const stored = await store.listSettings();
          return {
            webhook_url: stored.webhook_url ?? "",
            webhook_enabled: stored.webhook_enabled ?? "true",
            webhook_format: stored.webhook_format ?? "slack",
            raw_ttl_days: stored.raw_ttl_days ?? String(defaultRawTtlDays),
          };
        };
        if (req.method === "GET")
          return json(200, { settings: await effective() });
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
            if (key === "raw_ttl_days" && value !== null) {
              const days =
                typeof value === "number"
                  ? value
                  : Number(String(value).trim());
              if (!Number.isInteger(days) || days < 1)
                return json(400, {
                  error: "raw_ttl_days must be a positive integer",
                });
            }
          }
          const before = await store.listSettings();
          for (const [key, value] of Object.entries(body)) {
            // explicit null clears the setting (e.g. unset webhook_url);
            // JSON bodies can't carry undefined, but stay defensive
            if (value === null) {
              await store.clearSetting(key);
              continue;
            }
            if (value === undefined) continue;
            await store.setSetting(key, String(value));
          }
          const after = await store.listSettings();
          const changes: Record<
            string,
            { before: string | null; after: string | null }
          > = {};
          for (const key of Object.keys(body)) {
            const b = before[key] ?? null;
            const a = after[key] ?? null;
            if (b !== a) changes[key] = { before: b, after: a };
          }
          if (Object.keys(changes).length > 0)
            await audit(
              adminActor,
              "settings.update",
              Object.keys(changes).join(", "),
              { changes },
            );
          return json(200, { settings: await effective() });
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
        const sessionId = decodeURIComponent(sessionMatch[1]!);
        // ADR 0007: the session and its events vanish — snapshot them into
        // the entry so the trail outlives what it describes.
        const snap = await store.getSession(sessionId);
        if (await store.deleteSession(sessionId)) {
          await audit(
            adminActor,
            "session.delete",
            sessionId,
            snap === null
              ? {}
              : {
                  agent: snap.agent,
                  user: snap.user_id,
                  title: snap.title,
                  events: snap.last_seq,
                  input_tokens: snap.total_input_tokens,
                  output_tokens: snap.total_output_tokens,
                  cache_read_tokens: snap.total_cache_read_tokens,
                  cache_write_tokens: snap.total_cache_write_tokens,
                },
          );
          return json(200, { ok: true });
        }
        return json(404, { error: "no such session" });
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
