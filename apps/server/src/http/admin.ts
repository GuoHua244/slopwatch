import {
  NoSuchTeamError,
  TeamExistsError,
  UserExistsError,
  type AuditActor,
  type Store,
} from "../store";
import {
  SETTING_KEYS,
  loadWebhookConfig,
  postWebhook,
  webhookBody,
} from "../webhook";
import { bearerToken, timingSafeTokenEq, type Auth } from "./auth";
import type { Audit } from "./audit";
import { HttpError, json } from "./respond";
import {
  RETENTION_ERROR,
  UUID_RE,
  decodeParam,
  isRetention,
  readJsonOr400,
  trimField,
  windowParam,
} from "./validate";

export type AdminContext = {
  store: Store;
  /**
   * Operator bypass bearer (decision 13). Optional and no longer the only way
   * in: a signed-in user with the admin role passes the same gate. Unset
   * simply removes the bypass.
   */
  adminToken?: string;
  /**
   * The S3-compatible cold archive (v2 decision 21). Present, GET
   * /admin/archive can fetch an archived raw payload back by key; absent the
   * route answers 400.
   */
  archive?: { getObject(key: string): Promise<string> };
  /**
   * The raw-TTL default the settings plane falls back to when the operator
   * has not stored an override (the env RAW_TTL_DAYS at boot).
   */
  defaultRawTtlDays: number;
  audit: Audit;
  requireReader: Auth["requireReader"];
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

/**
 * Await a store write that may hit a unique-name collision: a
 * TeamExistsError/UserExistsError becomes the thrown 409 sentinel, anything
 * else rethrows untouched.
 */
const conflictOrThrow = async <T>(pending: Promise<T>): Promise<T> => {
  try {
    return await pending;
  } catch (e) {
    if (e instanceof TeamExistsError || e instanceof UserExistsError)
      throw new HttpError(json(409, { error: e.message }));
    throw e;
  }
};

/**
 * The admin plane (decision 13, now role-based): a signed-in user with the
 * admin role passes; SLOPWATCH_ADMIN_TOKEN stays as the operator bypass for
 * bootstrapping the first admin and break-glass access. Returns null when the
 * path lives under /admin but no route handled it, leaving the caller to fall
 * through to static serving / 404 as before.
 */
export const handleAdmin = async (
  req: Request,
  url: URL,
  {
    store,
    adminToken,
    archive,
    defaultRawTtlDays,
    audit,
    requireReader,
  }: AdminContext,
): Promise<Response | null> => {
  const bearer = bearerToken(req);
  // Null when the caller is the operator bypass — there is no user
  // identity to attribute, which only the self-role guard below cares
  // about.
  let caller: string | null = null;
  if (bearer === null)
    throw new HttpError(json(401, { error: "unauthorized" }));
  if (adminToken === undefined || !timingSafeTokenEq(bearer, adminToken)) {
    const reader = await requireReader(req);
    if (reader.role !== "admin")
      throw new HttpError(json(403, { error: "the admin role is required" }));
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
            ? // clamp: astronomic offsets overflow the bigint parameter
              Math.min(Math.floor(offsetRaw), 1_000_000_000)
            : 0,
        kind:
          url.searchParams.get("kind")?.trim().replace(/\.+$/, "") || undefined,
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
      const body = await readJsonOr400(req);
      const name = trimField(body.name, 100);
      if (name === null)
        return json(400, { error: "name must be a non-empty string" });
      if (!isRetention(body.raw_retention_days))
        return json(400, { error: RETENTION_ERROR });
      const retention = body.raw_retention_days ?? null;
      const team = await conflictOrThrow(store.createTeam(name, retention));
      await audit(adminActor, "team.create", name, {
        id: team.id,
        raw_retention_days: retention,
      });
      return json(201, { team });
    }
  }

  const teamMatch = url.pathname.match(/^\/admin\/teams\/([^/]+)$/);
  if (teamMatch) {
    const id = decodeParam(teamMatch[1]!);
    // Team ids are UUIDs — a malformed (non-UUID) id must 404, not
    // surface a Postgres cast error from the store below.
    if (id === null || !UUID_RE.test(id))
      return json(404, { error: "no such team" });
    if (req.method === "PATCH") {
      const body = await readJsonOr400(req);
      const { name, raw_retention_days } = body;
      if (name !== undefined && trimField(name, 100) === null)
        return json(400, { error: "name must be a non-empty string" });
      if (!isRetention(raw_retention_days))
        return json(400, { error: RETENTION_ERROR });
      if (name === undefined && raw_retention_days === undefined)
        return json(400, { error: "nothing to update" });
      const before = await store.getTeam(id);
      const team = await conflictOrThrow(
        store.updateTeam(id, {
          ...(name !== undefined ? { name: trimField(name, 100)! } : {}),
          ...(raw_retention_days !== undefined ? { raw_retention_days } : {}),
        }),
      );
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
      const body = await readJsonOr400(req);
      const name = trimField(body.name, 100);
      const email = trimField(body.email, 200);
      if (name === null)
        return json(400, { error: "name must be a non-empty string" });
      const user = await conflictOrThrow(store.createUser(name, email));
      await audit(adminActor, "user.create", name, { email });
      return json(201, { user });
    }
  }

  const userMatch = url.pathname.match(/^\/admin\/users\/([^/]+)$/);
  if (userMatch) {
    const name = decodeParam(userMatch[1]!);
    if (name === null) return json(400, { error: "malformed user name" });
    if (req.method === "PATCH") {
      const body = await readJsonOr400(req);
      const { disabled, is_dri, team_id, role } = body;
      if (disabled !== undefined && typeof disabled !== "boolean")
        return json(400, { error: "disabled must be a boolean" });
      if (is_dri !== undefined && typeof is_dri !== "boolean")
        return json(400, { error: "is_dri must be a boolean" });
      if (
        team_id !== undefined &&
        team_id !== null &&
        (typeof team_id !== "string" || !UUID_RE.test(team_id))
      )
        return json(400, { error: "team_id must be a UUID or null" });
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

  const tokensMatch = url.pathname.match(/^\/admin\/users\/([^/]+)\/tokens$/);
  if (tokensMatch) {
    const name = decodeParam(tokensMatch[1]!);
    if (name === null) return json(400, { error: "malformed user name" });
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
    const id = decodeParam(tokenMatch[1]!);
    if (id === null || !UUID_RE.test(id))
      return json(404, { error: "no such token" });
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
    if (req.method === "GET") return json(200, { settings: await effective() });
    if (req.method === "PUT") {
      const body = await readJsonOr400(req);
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
        if (key === "webhook_enabled" && value !== "true" && value !== "false")
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
            typeof value === "number" ? value : Number(String(value).trim());
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
    if (cfg === null) return json(400, { error: "webhook is not configured" });
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
    const sessionId = decodeParam(sessionMatch[1]!);
    if (sessionId === null) return json(400, { error: "malformed session id" });
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

  return null;
};
