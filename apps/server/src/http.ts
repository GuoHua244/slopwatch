import {
  isNormalEvent,
  SCHEMA_VERSION,
  type NormalEvent,
} from "@slopwatch/events";
import { handleAdmin } from "./http/admin";
import { createAudit, type Audit } from "./http/audit";
import { createAuth, type Auth } from "./http/auth";
import { HttpError, json, text } from "./http/respond";
import { staticFile, staticResponse } from "./http/static";
import {
  decodeParam,
  readJsonOr400,
  trimField,
  windowParam,
} from "./http/validate";
import type { Store } from "./store";
import { pushSessionEnds } from "./webhook";
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

/** Everything a route handler needs beyond the request itself. */
type RouteContext = {
  store: Store;
  staticRoot?: string;
  adminToken?: string;
  archive?: { getObject(key: string): Promise<string> };
  defaultRawTtlDays: number;
  auth: Auth;
  audit: Audit;
};

/**
 * Route one request. Auth/400 guards throw prebuilt HttpError responses; the
 * catch in fetch is the single place that turns them back into responses.
 */
const route = async (
  req: Request,
  url: URL,
  {
    store,
    staticRoot,
    adminToken,
    archive,
    defaultRawTtlDays,
    auth,
    audit,
  }: RouteContext,
): Promise<Response> => {
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
    const user = await auth.requireUser(req);

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
    // A token holder may append only to their own sessions: an unknown id
    // creates one owned by the sender, a foreign id answers 404 so
    // existence never leaks (ADR 0006's rationale) — and ingest credits the
    // appender while recompute credits the owner, so letting them diverge
    // would corrupt attribution.
    for (const sessionId of new Set(events.map((e) => e.session_id))) {
      const owner = await store.sessionOwner(sessionId);
      if (owner !== null && owner !== user)
        return json(404, { error: "no such session" });
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
    const reader = await auth.requireReader(req);
    const sessionId = decodeParam(eventsMatch[1]!);
    if (sessionId === null) return json(400, { error: "malformed session id" });
    // Members may only read their own sessions' payloads; a foreign or
    // unknown id answers 404 so existence never leaks across users.
    if (reader.role !== "admin") {
      const owner = await store.sessionOwner(sessionId);
      if (owner !== reader.user) return json(404, { error: "no such session" });
    }
    const sinceSeq = Number(url.searchParams.get("since_seq") ?? 0);
    const events = await store.eventsSince(
      sessionId,
      // clamp: astronomic values overflow the Postgres bigint parameter
      Number.isFinite(sinceSeq) && sinceSeq >= 0
        ? Math.min(sinceSeq, Number.MAX_SAFE_INTEGER)
        : 0,
    );
    return json(200, { session_id: sessionId, events });
  }

  if (url.pathname === "/sessions" && req.method === "GET") {
    const reader = await auth.requireReader(req);
    // Team-scoped DRI filter: "unassigned" is the NULL-team bucket. Members
    // are always scoped to their own sessions regardless of the filter.
    const teamId = url.searchParams.get("team_id")?.trim() || undefined;
    // ?user_id= narrows to one developer — admins only; members stay pinned
    // to themselves so the parameter can never widen their read.
    const userIdParam = url.searchParams.get("user_id")?.trim() || undefined;
    return json(200, {
      sessions: await store.listSessions(
        teamId,
        reader.role === "admin" ? userIdParam : reader.user,
      ),
    });
  }

  // Decision 18: per-developer usage rollups. Admins read org-wide (the
  // leaderboard); members only ever receive their own rows.
  if (url.pathname === "/rollups" && req.method === "GET") {
    const reader = await auth.requireReader(req);
    const days = windowParam(url.searchParams.get("days"), 3650, 30);
    // hourly ceiling = 31 days so the local-calendar-day charts (decision 27)
    // can re-bucket a full month of UTC hours
    const hours = windowParam(url.searchParams.get("hours"), 31 * 24, 24);
    const teamId = url.searchParams.get("team_id")?.trim() || undefined;
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
    const user = await auth.requireUser(req);
    return json(200, { teams: await store.teamsWithMembers() });
  }

  // --- Read-plane identity: GET /me — the signed-in user plus their
  // lifetime footprint, the one payload the profile page needs. First
  // sight also provisions the users row, so env-token users become
  // manageable by role and team without a manual create. ---
  if (url.pathname === "/me" && req.method === "GET") {
    const reader = await auth.requireReader(req);
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
    const sessionId = decodeParam(reviewMatch[1]!);
    if (sessionId === null) return json(400, { error: "malformed session id" });
    if (req.method === "GET") {
      const user = await auth.requireUser(req);
      return json(200, { review: await store.reviewFor(sessionId) });
    }
    if (req.method === "POST" || req.method === "DELETE") {
      const user = await auth.requireUser(req);
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
    const sessionId = decodeParam(commentsMatch[1]!);
    if (sessionId === null) return json(400, { error: "malformed session id" });
    if (req.method === "GET") {
      const user = await auth.requireUser(req);
      return json(200, { comments: await store.listComments(sessionId) });
    }
    if (req.method === "POST") {
      const user = await auth.requireUser(req);
      const body = await readJsonOr400(req);
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
    const user = await auth.requireUser(req);
    const sessionId = decodeParam(commentMatch[1]!);
    if (sessionId === null) return json(400, { error: "malformed session id" });
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
    const response = await handleAdmin(req, url, {
      store,
      adminToken,
      archive,
      defaultRawTtlDays,
      audit,
      requireReader: auth.requireReader,
    });
    if (response !== null) return response;
  }

  // Exact-name static assets after the API routes — unknown paths still 404.
  if (staticRoot && (req.method === "GET" || req.method === "HEAD")) {
    const file = staticFile(staticRoot, url.pathname);
    if (file) return staticResponse(file, req.method);
  }

  return json(404, { error: "not found" });
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
    const auth = createAuth({ tokens, store, oidc });
    const audit = createAudit(store);
    try {
      return await route(req, url, {
        store,
        staticRoot,
        adminToken,
        archive,
        defaultRawTtlDays,
        auth,
        audit,
      });
    } catch (e) {
      // Guards throw prebuilt responses for the auth/400 prologues; anything
      // else keeps escaping exactly as before the guards existed.
      if (e instanceof HttpError) return e.response;
      throw e;
    }
  },
});
