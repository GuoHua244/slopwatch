import type { OidcIdentity } from "../oidc";
import { appendAudit } from "./audit";
import type { PgCtx } from "./db";
import { UserExistsError } from "./errors";
import { MODEL_SUMS } from "./rollups";
import {
  asRole,
  hashToken,
  iso,
  mintTokenValue,
  modelRollupRow,
  pgUserRow,
} from "./rows";
import type { AdminUserRow, MeUsage, Role, Store } from "./types";

const USER_SELECT = `
  SELECT u.name, u.email, u.disabled, u.is_dri, u.role, u.created_at,
         u.team_id, t.name AS team_name,
         u.password_hash IS NOT NULL AS password_set,
         (SELECT COUNT(*) FROM tokens t2 WHERE t2.user_name = u.name AND t2.revoked_at IS NULL) AS active_tokens
  FROM users u LEFT JOIN teams t ON t.id = u.team_id`;

/** The one user-row read — the store method and every mutation's echo. */
export const getUserRow = async (
  ctx: PgCtx,
  name: string,
): Promise<AdminUserRow | null> => {
  const { rows } = await ctx.pool.query(`${USER_SELECT} WHERE u.name = $1`, [
    name,
  ]);
  return rows[0] ? pgUserRow(rows[0]) : null;
};

export const userMethods = (
  ctx: PgCtx,
): Pick<
  Store,
  | "createUser"
  | "getUser"
  | "listUsers"
  | "setUserDisabled"
  | "deleteUser"
  | "mintToken"
  | "listTokens"
  | "revokeToken"
  | "resolveTokenUser"
  | "resolveOidcUser"
  | "isDri"
  | "setUserDri"
  | "roleOf"
  | "setUserRole"
  | "ensureUser"
  | "ensureAdmin"
  | "ownUsage"
  | "getToken"
> => {
  const { pool } = ctx;
  return {
    async createUser(name, email) {
      try {
        const { rows } = await pool.query(
          "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING name, email, disabled, created_at",
          [name, email],
        );
        return pgUserRow({ ...rows[0]!, active_tokens: 0 });
      } catch (e) {
        if ((e as { code?: string }).code === "23505")
          throw new UserExistsError(name);
        throw e;
      }
    },

    async getUser(name) {
      return getUserRow(ctx, name);
    },

    async listUsers() {
      const { rows } = await pool.query(
        `${USER_SELECT} ORDER BY u.created_at ASC`,
      );
      return rows.map((r) => pgUserRow(r));
    },

    async setUserDri(name, isDri) {
      await pool.query("UPDATE users SET is_dri = $2 WHERE name = $1", [
        name,
        isDri,
      ]);
      return getUserRow(ctx, name);
    },

    async roleOf(name) {
      const { rows } = await pool.query(
        "SELECT role FROM users WHERE name = $1",
        [name],
      );
      return asRole(rows[0]?.role);
    },

    async setUserRole(name, role) {
      await pool.query("UPDATE users SET role = $2 WHERE name = $1", [
        name,
        role,
      ]);
      return getUserRow(ctx, name);
    },

    async ensureUser(name) {
      const { rowCount } = await pool.query(
        "INSERT INTO users (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
        [name],
      );
      return (rowCount ?? 0) > 0;
    },

    async ensureAdmin(name) {
      await pool.query(
        `INSERT INTO users (name, role) VALUES ($1, 'admin')
         ON CONFLICT (name) DO UPDATE SET role = 'admin', disabled = FALSE`,
        [name],
      );
    },

    async ownUsage(name) {
      const sessionStats = await pool.query(
        `SELECT COUNT(*) AS sessions,
                MIN(first_seen_at) AS first_seen_at,
                MAX(COALESCE(last_event_at, first_seen_at)) AS last_seen_at
         FROM sessions WHERE user_id = $1`,
        [name],
      );
      const totals = await pool.query(
        `SELECT SUM(turns) AS turns, SUM(tool_calls) AS tool_calls
         FROM user_daily_rollup WHERE user_id = $1`,
        [name],
      );
      const modelTotals = await pool.query(
        `SELECT user_id, '' AS bucket, model, ${MODEL_SUMS}
         FROM model_daily_rollup WHERE user_id = $1
         GROUP BY user_id, model ORDER BY model`,
        [name],
      );
      return {
        sessions: Number(sessionStats.rows[0]?.sessions ?? 0),
        first_seen_at: sessionStats.rows[0]?.first_seen_at
          ? iso(sessionStats.rows[0]!.first_seen_at)
          : null,
        last_seen_at: sessionStats.rows[0]?.last_seen_at
          ? iso(sessionStats.rows[0]!.last_seen_at)
          : null,
        turns: Number(totals.rows[0]?.turns ?? 0),
        tool_calls: Number(totals.rows[0]?.tool_calls ?? 0),
        model_totals: modelTotals.rows.map(modelRollupRow),
      };
    },

    async setUserDisabled(name, disabled) {
      await pool.query("UPDATE users SET disabled = $2 WHERE name = $1", [
        name,
        disabled,
      ]);
      return getUserRow(ctx, name);
    },

    async deleteUser(name) {
      const { rowCount } = await pool.query(
        "DELETE FROM users WHERE name = $1",
        [name],
      );
      return (rowCount ?? 0) > 0;
    },

    async mintToken(userName, label) {
      const { token, hash, hint } = mintTokenValue();
      const { rows } = await pool.query(
        "INSERT INTO tokens (token_id, token_hash, hint, user_name, label) VALUES ($1, $2, $3, $4, $5) RETURNING token_id",
        [crypto.randomUUID(), hash, hint, userName, label ?? null],
      );
      return {
        token_id: rows[0]!.token_id as string,
        hint,
        token,
        label: label ?? null,
      };
    },

    async listTokens(userName) {
      const { rows } = await pool.query(
        "SELECT token_id, hint, label, created_at, revoked_at FROM tokens WHERE user_name = $1 ORDER BY created_at ASC",
        [userName],
      );
      return rows.map((r) => ({
        token_id: r.token_id as string,
        hint: r.hint as string,
        label: (r.label as string | null) ?? null,
        created_at: iso(r.created_at),
        revoked_at: r.revoked_at ? iso(r.revoked_at) : null,
      }));
    },

    async revokeToken(tokenId) {
      const { rowCount } = await pool.query(
        "UPDATE tokens SET revoked_at = now() WHERE token_id = $1 AND revoked_at IS NULL",
        [tokenId],
      );
      return (rowCount ?? 0) > 0;
    },

    async resolveTokenUser(token) {
      const { rows } = await pool.query(
        `SELECT t.user_name FROM tokens t
         JOIN users u ON u.name = t.user_name
         WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND NOT u.disabled`,
        [hashToken(token)],
      );
      return (rows[0]?.user_name as string | undefined) ?? null;
    },

    async resolveOidcUser(identity) {
      if (identity.email !== null) {
        const byEmail = await pool.query(
          // ORDER BY pins the pick when two rows share an email (no unique
          // constraint) — otherwise the resolved identity is nondeterministic.
          "SELECT name FROM users WHERE email = $1 AND NOT disabled ORDER BY created_at LIMIT 1",
          [identity.email],
        );
        if (byEmail.rows[0] !== undefined)
          return byEmail.rows[0]!.name as string;
      }
      const candidate = identity.preferredUsername ?? identity.subject;
      const byName = await pool.query(
        "SELECT name FROM users WHERE name = $1 AND NOT disabled",
        [candidate],
      );
      if (byName.rows[0] !== undefined) return byName.rows[0]!.name as string;
      try {
        // First sighting through the issuer: provision the row so OIDC
        // onboarding needs no admin-minted token. Team and DRI stay admin
        // decisions, so they start unset.
        await pool.query("INSERT INTO users (name, email) VALUES ($1, $2)", [
          candidate,
          identity.email,
        ]);
        // ADR 0007: the one store-internal audit — creation happens inside
        // auth resolution, below the handler layer that owns every other
        // entry. Best-effort: a failed append must not fail the login.
        try {
          await appendAudit(ctx, {
            actor: { kind: "user", user: candidate },
            action: "user.provision",
            target: candidate,
            detail: { via: "oidc", email: identity.email },
          });
        } catch (e) {
          console.error("audit append failed:", e);
        }
        return candidate;
      } catch (e) {
        // The name exists but did not resolve above — a disabled user, or a
        // row whose email claims a different person. Refuse rather than
        // merge two identities into one account.
        if ((e as { code?: string }).code === "23505") return null;
        throw e;
      }
    },

    async isDri(name) {
      const { rows } = await pool.query(
        "SELECT is_dri FROM users WHERE name = $1",
        [name],
      );
      return rows[0]?.is_dri === true;
    },

    async getToken(tokenId) {
      const { rows } = await pool.query(
        "SELECT token_id, hint, label, user_name, created_at, revoked_at FROM tokens WHERE token_id = $1",
        [tokenId],
      );
      return rows[0]
        ? {
            token_id: rows[0]!.token_id as string,
            hint: rows[0]!.hint as string,
            label: (rows[0]!.label as string | null) ?? null,
            user_name: rows[0]!.user_name as string,
            created_at: iso(rows[0]!.created_at),
            revoked_at: rows[0]!.revoked_at ? iso(rows[0]!.revoked_at) : null,
          }
        : null;
    },
  };
};
