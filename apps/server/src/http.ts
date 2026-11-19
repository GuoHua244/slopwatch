import {
  isNormalEvent,
  SCHEMA_VERSION,
  type NormalEvent,
} from "@slopwatch/events";
import { checkAlerts } from "./alerts";
import { handleAdmin } from "./http/admin";
import { createAudit, type Audit } from "./http/audit";
import { createAuth, type Auth, type Reader } from "./http/auth";
import { parseFeedbackForm } from "./http/feedback";
import {
  createLoginGuard,
  DEFAULT_LOGIN_GUARD,
  handleAuthLogin,
  handleAuthLogout,
  handleMePassword,
  type LoginGuard,
  type LoginGuardConfig,
} from "./http/password";
import { attachmentResponse, HttpError, json, text } from "./http/respond";
import { staticFile, staticResponse } from "./http/static";
import {
  readJsonOr400,
  requireSessionId,
  trimField,
  windowParam,
} from "./http/validate";
import {
  CUSTOM_ANGLE_ID,
  DEFAULT_ANGLES,
  RETRO_ANGLES_SETTING_KEY,
  RETRO_SYSTEM_CORE,
  effectiveRetroAngles,
} from "./retrospective/presets";
import type { RetroQueue } from "./retrospective/queue";
import { buildTranscript, failureRawSeqs } from "./retrospective/transcript";
import type { SummaryFold } from "./summary-fold";
import type { Store } from "./store";
import { pushSessionEnds } from "./webhook";
import type { OidcVerifier } from "./oidc";

export type App = { fetch: (req: Request) => Promise<Response> };

export type AppOptions = {
  /** bearer token → user name (bootstrap from env; admin-minted, decision 6). */
  tokens: Map<string, string>;
  store: Store;
  /**
   * Directory of the built dashboard (apps/web/dist) served same-origin
   * (decision 12). Absent or unbuilt, GET / answers 503 with a build hint.
   */
  staticRoot?: string;
  /**
   * Operator bypass bearer for the admin plane (decision 13). Optional: a
   * signed-in user with the admin role also passes the same gate. Unset
   * simply removes the bypass.
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
  /**
   * ADR 0008: the in-process retrospective runner. Present, POST
   * /sessions/:id/retrospectives schedules runs on it; absent (tests),
   * triggers answer 503.
   */
  retrospectives?: RetroQueue;
  /**
   * Decision 28: the summary-fold runner executing LLM calls on the
   * caller's own profile credentials. Present, GET /summary/llm reports
   * credential status and POST /summary/fold runs one fold; absent
   * (tests), both answer 503.
   */
  summaryFold?: SummaryFold;
  /**
   * ADR 0011: POST /auth/login's per-name failure throttling. Tests pass a
   * tighter config to exercise the lockout quickly; production uses the
   * default (10 failures, 15-minute lockout).
   */
  loginGuard?: LoginGuardConfig;
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
  retrospectives?: RetroQueue;
  summaryFold?: SummaryFold;
  guard: LoginGuard;
};

/** Masked form of a stored LLM api key — the only shape any read returns. */
export const maskKey = (key: string): string => `••••${key.slice(-4)}`;

/**
 * Session read scope (ADR 0006): a member may only read sessions they own; an
 * admin passes any id. A foreign or unknown id answers 404 — not 403 — so
 * existence never leaks across users.
 */
const assertReadableSession = async (
  sessionId: string,
  reader: Reader,
  store: Store,
): Promise<void> => {
  if (reader.role !== "admin") {
    const owner = await store.sessionOwner(sessionId);
    if (owner !== reader.user)
      throw new HttpError(json(404, { error: "no such session" }));
  }
};

/**
 * Postgres's "this content can never be stored" codes from the pg driver:
 * 22P05 rejects jsonb input with \u0000 escapes, 22021 rejects text carrying
 * the raw NUL byte. Both are permanent content faults — no retry will ever
 * succeed. The store strips NULs at its serialization boundary, so these are
 * last-resort defense against an unknown poison path.
 */
const isUnstorableContent = (e: unknown): boolean => {
  const code = (e as { code?: string } | null)?.code;
  return code === "22P05" || code === "22021";
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
    retrospectives,
    summaryFold,
    guard,
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
    let accepted: number;
    try {
      ({ accepted } = await store.appendEvents(events, user));
    } catch (e) {
      if (isUnstorableContent(e)) {
        // Answer 422, not the default 500: the listeners classify any other
        // 4xx as a permanent rejection and drop the batch, while a 500 makes
        // their disk queues retry forever — wedging every later batch behind
        // the poison head (2026-10-08 incident: wsl.exe UTF-16 output).
        console.error("ingest: unstorable content, dropping batch:", e);
        return json(422, {
          error: "event content cannot be stored (NUL byte)",
        });
      }
      throw e;
    }
    // v2 decision 25: finished sessions push to the org webhook —
    // fire-and-forget, never part of the ingest response
    pushSessionEnds(store, events, user);
    // v3 decision 33: threshold alerts ride the same fire-and-forget slot —
    // both checks push over the same webhook and audit their findings.
    checkAlerts(store, events, user);
    return json(202, { accepted });
  }

  // --- Read plane (v2 decision 22, ADR 0003): every read requires a
  // bearer token — an intranet visitor must never read prompt payloads.
  // /healthz above stays anonymous as the ops probe. ---
  const eventsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/events$/);
  if (eventsMatch && req.method === "GET") {
    const reader = await auth.requireReader(req);
    const sessionId = requireSessionId(eventsMatch[1]!);
    // Members may only read their own sessions' payloads; a foreign or
    // unknown id answers 404 so existence never leaks across users.
    await assertReadableSession(sessionId, reader, store);
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

  // One captured attachment's bytes — same read-plane gate and member scoping as
  // the events route. sha256-addressed, so the response is safe to cache
  // forever; `private` keeps it out of shared proxy caches.
  const attachmentMatch = url.pathname.match(
    /^\/sessions\/([^/]+)\/attachments\/([0-9a-f]{64})$/,
  );
  if (attachmentMatch && req.method === "GET") {
    const reader = await auth.requireReader(req);
    const sessionId = requireSessionId(attachmentMatch[1]!);
    await assertReadableSession(sessionId, reader, store);
    const attachment = await store.getAttachment(
      sessionId,
      attachmentMatch[2]!,
    );
    if (attachment === null) return json(404, { error: "no such attachment" });
    return attachmentResponse(attachment);
  }

  // --- Retrospectives (ADR 0008): visibility follows the session read
  // scope — whoever can read a session's events can trigger and read its
  // retrospectives. Runs bill to the triggering user's own LLM credentials;
  // a user without credentials gets 409 with the fix, not a silent 403. ---
  const retroAnglesMatch = url.pathname.match(/^\/retrospectives\/angles$/);
  if (retroAnglesMatch && req.method === "GET") {
    await auth.requireReader(req);
    const angles = effectiveRetroAngles(
      await store.getSetting(RETRO_ANGLES_SETTING_KEY),
    ).map(({ id, title }) => ({ id, title }));
    return json(200, {
      angles: [
        ...angles,
        { id: CUSTOM_ANGLE_ID, title: "自由复盘（自定义指令）" },
      ],
    });
  }

  const retrosMatch = url.pathname.match(
    /^\/sessions\/([^/]+)\/retrospectives$/,
  );
  if (retrosMatch) {
    const sessionId = requireSessionId(retrosMatch[1]!);
    if (req.method === "GET") {
      const reader = await auth.requireReader(req);
      await assertReadableSession(sessionId, reader, store);
      if ((await store.getSession(sessionId)) === null) {
        return json(404, { error: "no such session" });
      }
      return json(200, {
        retrospectives: await store.listRetros(sessionId),
      });
    }
    if (req.method === "POST") {
      const reader = await auth.requireReader(req);
      await assertReadableSession(sessionId, reader, store);
      const session = await store.getSession(sessionId);
      if (session === null) return json(404, { error: "no such session" });
      const body = await readJsonOr400(req);
      const angle = trimField(body.angle, 40);
      const supplement = trimField(body.supplement, 4000);
      if (angle === null)
        return json(400, { error: "angle must be a non-empty string" });
      const preset =
        angle === CUSTOM_ANGLE_ID
          ? null
          : effectiveRetroAngles(
              await store.getSetting(RETRO_ANGLES_SETTING_KEY),
            ).find((a) => a.id === angle);
      if (preset === undefined)
        return json(400, { error: `unknown retrospective angle "${angle}"` });
      if (preset === null && supplement === null)
        return json(400, {
          error:
            "a custom retrospective needs its instruction text in `supplement`",
        });
      const credentials = await store.getLlmConfig(reader.user);
      if (credentials === null)
        return json(409, {
          error:
            "retrospectives run on your own LLM credentials — configure endpoint, model, and API key on your profile page first",
        });
      if (await store.hasOpenRetroFor(reader.user))
        return json(409, {
          error:
            "you already have a retrospective queued or running — one at a time per user",
        });
      if (retrospectives === undefined)
        return json(503, { error: "the retrospective runner is unavailable" });
      // The whole input is built (and snapshotted) at trigger time: what the
      // triggerer saw is what the run analyzes, forever reproducible.
      const events = await store.allEvents(sessionId);
      const children = await store.childRollups(sessionId);
      const rawBySeq = new Map(
        (await store.rawForEvents(sessionId, failureRawSeqs(events))).map(
          (r) => [r.event_seq, r.raw],
        ),
      );
      const transcript = buildTranscript({
        session,
        events,
        children,
        rawBySeq,
      });
      const system =
        preset === null
          ? `${RETRO_SYSTEM_CORE}\n\n【本角度使命】本次复盘没有预设角度——以下是触发者自定义的复盘指令，请以其为准，但证据纪律与输出要求仍然全部适用：\n\n${supplement}`
          : `${RETRO_SYSTEM_CORE}\n\n${preset.prompt}`;
      const user =
        transcript.text +
        (preset !== null && supplement !== null
          ? `\n\n# 补充关注点（触发者附言，优先核查）\n${supplement}`
          : "");
      const retro = await store.createRetro({
        sessionId,
        userId: reader.user,
        angle,
        supplement,
        systemSnapshot: system,
        promptSnapshot: user,
      });
      await audit(
        { kind: "user", user: reader.user },
        "retrospective.trigger",
        sessionId,
        {
          retro_id: retro.id,
          angle,
          supplement_chars: supplement?.length ?? 0,
          estimated_input_tokens: transcript.estimatedTokens,
          compacted_turns: transcript.compactedTurns,
          raw_enriched_turns: transcript.enrichedTurns,
        },
      );
      retrospectives.enqueue(retro.id);
      return json(201, {
        retro: {
          ...retro,
          system_snapshot: undefined,
          prompt_snapshot: undefined,
        },
        estimate: {
          input_tokens: transcript.estimatedTokens,
          budget_tokens: transcript.budgetTokens,
          compacted_turns: transcript.compactedTurns,
          raw_enriched_turns: transcript.enrichedTurns,
        },
      });
    }
  }

  // --- Summary folds on the caller's own credentials (decision 28): the
  // listener ships the fold prompt, the server executes the LLM call with
  // the profile config, and the key never leaves the process — ADR 0008's
  // write-only rule holds. An unconfigured user answers 409; the listener
  // reads that as "no summary" and stays silent. ---
  if (url.pathname === "/summary/llm" && req.method === "GET") {
    const reader = await auth.requireReader(req);
    if (summaryFold === undefined)
      return json(503, { error: "the summary fold runner is unavailable" });
    return json(200, {
      configured: await summaryFold.configured(reader.user),
    });
  }
  if (url.pathname === "/summary/fold" && req.method === "POST") {
    const reader = await auth.requireReader(req);
    if (summaryFold === undefined)
      return json(503, { error: "the summary fold runner is unavailable" });
    if (!(await summaryFold.configured(reader.user)))
      return json(409, {
        error:
          "summaries run on your own LLM credentials — configure endpoint, model, and API key on your profile page first",
      });
    const body = await readJsonOr400(req);
    const system = trimField(body.system, 4000);
    const prompt = trimField(body.user, 40_000);
    if (system === null || prompt === null)
      return json(400, {
        error: "system and user must be non-empty strings",
      });
    const maxTokens =
      typeof body.max_tokens === "number" &&
      Number.isSafeInteger(body.max_tokens) &&
      body.max_tokens > 0
        ? body.max_tokens
        : 4096;
    const result = await summaryFold.run(reader.user, {
      system,
      user: prompt,
      maxTokens,
    });
    if (!result.ok) return json(502, { error: result.error });
    return json(200, {
      text: result.text,
      model: result.model,
      ...(result.usage ? { usage: result.usage } : {}),
    });
  }

  if (url.pathname === "/sessions" && req.method === "GET") {
    const reader = await auth.requireReader(req);
    // Team-scoped DRI filter: membership resolves through the owner's
    // current team (decision 27, same as the leaderboard), so "unassigned"
    // means the owner has no team. Members are always scoped to their own
    // sessions regardless of the filter.
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

  // --- Password sign-in (ADR 0011): the human-facing door. /auth/login
  // is anonymous by design — it *is* the authentication. /auth/logout
  // revokes the bearer's session when it is one; PUT /me/password sets or
  // changes the caller's password. ---
  if (url.pathname === "/auth/login" && req.method === "POST") {
    return handleAuthLogin(req, { store, guard, audit });
  }
  if (url.pathname === "/auth/logout" && req.method === "POST") {
    return handleAuthLogout(req, store);
  }
  if (url.pathname === "/me/password" && req.method === "PUT") {
    return handleMePassword(req, await auth.requireReader(req), {
      store,
      audit,
    });
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
    // ADR 0008: the profile page needs to know whether retrospectives are
    // available to this user — credentials come back masked, never plain.
    const credentials = await store.getLlmConfig(reader.user);
    return json(200, {
      user: reader.user,
      role: reader.role,
      email: row?.email ?? null,
      team_name: row?.team_name ?? null,
      is_dri: row?.is_dri ?? false,
      // ADR 0011: the sign-in page offers password sign-in only when the
      // user has one; the profile page and the admin panel read this too.
      password_set: row?.password_set ?? false,
      created_at: row?.created_at ?? null,
      llm:
        credentials === null
          ? null
          : {
              endpoint: credentials.endpoint,
              model: credentials.model,
              api_key_hint: maskKey(credentials.apiKey),
            },
      usage: await store.ownUsage(reader.user),
    });
  }

  // ADR 0008: each user's own LLM credentials. The api key is write-only —
  // a blank field on update keeps the stored one, and no read ever returns it.
  if (url.pathname === "/me/llm" && req.method === "PUT") {
    const reader = await auth.requireReader(req);
    const body = await readJsonOr400(req);
    const endpoint = trimField(body.endpoint, 500);
    if (endpoint === null)
      return json(400, { error: "endpoint must be a non-empty string" });
    try {
      const parsed = new URL(endpoint);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        return json(400, { error: "endpoint must be an http(s) URL" });
    } catch {
      return json(400, { error: "endpoint must be a valid URL" });
    }
    const model = trimField(body.model, 200);
    if (model === null)
      return json(400, { error: "model must be a non-empty string" });
    const rawKey = body.api_key;
    const apiKey =
      rawKey === undefined || rawKey === null || String(rawKey).trim() === ""
        ? null
        : trimField(String(rawKey), 2000);
    const existing = await store.getLlmConfig(reader.user);
    if (apiKey === null && existing === null)
      return json(400, {
        error: "api_key is required the first time you configure LLM access",
      });
    const before = existing;
    await store.setLlmConfig(reader.user, {
      endpoint,
      model,
      apiKey: apiKey ?? existing!.apiKey,
    });
    await audit(
      { kind: "user", user: reader.user },
      "llm.update",
      reader.user,
      {
        endpoint,
        model,
        key_changed: apiKey !== null,
        first_configuration: before === null,
      },
    );
    return json(200, {
      llm: {
        endpoint,
        model,
        api_key_hint: maskKey(apiKey ?? existing!.apiKey),
      },
    });
  }

  if (url.pathname === "/me/llm" && req.method === "DELETE") {
    const reader = await auth.requireReader(req);
    await store.clearLlmConfig(reader.user);
    await audit({ kind: "user", user: reader.user }, "llm.clear", reader.user);
    return new Response(null, { status: 204 });
  }

  // --- Review plane (decision 10): reads are org-wide for token holders;
  // writes carry the reader's user token; the review marker itself is
  // DRI-exclusive. ---
  const reviewMatch = url.pathname.match(/^\/sessions\/([^/]+)\/review$/);
  if (reviewMatch) {
    const sessionId = requireSessionId(reviewMatch[1]!);
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
    const sessionId = requireSessionId(commentsMatch[1]!);
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
    const sessionId = requireSessionId(commentMatch[1]!);
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

  // --- Feedback (ADR 0009): a stateless signal channel, the Server's first
  // browser-initiated upload. Any signed-in user may file; a session anchor
  // follows the session read scope (the same owner-or-admin rule as the
  // retrospectives), so members can only flag what they can see. ---
  if (url.pathname === "/feedback" && req.method === "POST") {
    const user = await auth.requireUser(req);
    const parsed = await parseFeedbackForm(req);
    const feedback = await store.addFeedback({
      filerId: user,
      kind: parsed.kind,
      body: parsed.text,
      sessionId: null,
    });
    // A global feedback has no session FK to miss — the row cannot be null.
    if (feedback === null)
      return json(500, { error: "feedback row vanished unexpectedly" });
    await store.addFeedbackAttachments(feedback.feedback_id, parsed.files);
    await audit(
      { kind: "user", user },
      "feedback.create",
      String(feedback.feedback_id),
      {
        kind: feedback.kind,
        session_id: null,
        attachments: parsed.files.length,
      },
    );
    // Re-read: the insert's RETURNING snapshotted an empty attachment list.
    return json(201, {
      feedback: (await store.getFeedback(feedback.feedback_id)) ?? feedback,
    });
  }

  const sessionFeedbackMatch = url.pathname.match(
    /^\/sessions\/([^/]+)\/feedback$/,
  );
  if (sessionFeedbackMatch && req.method === "POST") {
    const reader = await auth.requireReader(req);
    const sessionId = requireSessionId(sessionFeedbackMatch[1]!);
    // Ownership before body parsing: never churn through an upload for a
    // session the filer cannot see. Unknown ids answer 404, not 403.
    await assertReadableSession(sessionId, reader, store);
    const parsed = await parseFeedbackForm(req);
    const feedback = await store.addFeedback({
      filerId: reader.user,
      kind: parsed.kind,
      body: parsed.text,
      sessionId,
    });
    if (feedback === null) return json(404, { error: "no such session" });
    await store.addFeedbackAttachments(feedback.feedback_id, parsed.files);
    await audit(
      { kind: "user", user: reader.user },
      "feedback.create",
      String(feedback.feedback_id),
      {
        kind: feedback.kind,
        session_id: sessionId,
        attachments: parsed.files.length,
      },
    );
    // Re-read: the insert's RETURNING snapshotted an empty attachment list.
    return json(201, {
      feedback: (await store.getFeedback(feedback.feedback_id)) ?? feedback,
    });
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
  retrospectives,
  summaryFold,
  loginGuard,
}: AppOptions): App => {
  const guard = createLoginGuard(loginGuard ?? DEFAULT_LOGIN_GUARD);
  return {
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
          retrospectives,
          summaryFold,
          guard,
        });
      } catch (e) {
        // Guards throw prebuilt responses for the auth/400 prologues; anything
        // else keeps escaping exactly as before the guards existed.
        if (e instanceof HttpError) return e.response;
        throw e;
      }
    },
  };
};
