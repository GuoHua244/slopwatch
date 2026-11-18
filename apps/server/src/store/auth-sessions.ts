import type { PgCtx } from "./db";
import { hashToken, mintSessionValue } from "./rows";
import type { Store } from "./types";

/**
 * ADR 0011: the password-login plane. Passwords live on the user row as
 * argon2id hashes (the handler layer hashes; the store stores); each login
 * mints one revocable session bearer, hashed and resolved exactly like the
 * admin-minted tokens.
 */
export const authSessionMethods = (
  ctx: PgCtx,
): Pick<
  Store,
  | "getPasswordAuth"
  | "setPasswordHash"
  | "clearPassword"
  | "createAuthSession"
  | "resolveAuthSession"
  | "revokeAuthSession"
  | "revokeAllAuthSessions"
> => {
  const { pool } = ctx;
  return {
    async getPasswordAuth(name) {
      const { rows } = await pool.query(
        "SELECT password_hash, disabled FROM users WHERE name = $1",
        [name],
      );
      const row = rows[0];
      return row
        ? {
            passwordHash: (row.password_hash as string | null) ?? null,
            disabled: row.disabled === true,
          }
        : null;
    },

    async setPasswordHash(name, hash) {
      const { rowCount } = await pool.query(
        "UPDATE users SET password_hash = $2 WHERE name = $1",
        [name, hash],
      );
      return (rowCount ?? 0) > 0;
    },

    async clearPassword(name) {
      const { rowCount } = await pool.query(
        "UPDATE users SET password_hash = NULL WHERE name = $1",
        [name],
      );
      return (rowCount ?? 0) > 0;
    },

    async createAuthSession(userName) {
      const { token, hash, sessionId } = mintSessionValue();
      await pool.query(
        "INSERT INTO auth_sessions (session_id, token_hash, user_name) VALUES ($1, $2, $3)",
        [sessionId, hash, userName],
      );
      return { token, session_id: sessionId };
    },

    async resolveAuthSession(token) {
      // One round trip resolves and refreshes the heartbeat: the data-
      // modifying CTE updates last_seen_at only when it has gone stale (so
      // a busy dashboard writes hourly, not per request), and the SELECT
      // keeps the revoked/disabled exclusions in SQL like every issuer.
      const { rows } = await pool.query(
        `WITH seen AS (
           UPDATE auth_sessions s
           SET last_seen_at = now()
           WHERE s.token_hash = $1 AND s.revoked_at IS NULL
             AND (s.last_seen_at IS NULL
                  OR s.last_seen_at < now() - interval '1 hour')
           RETURNING s.session_id
         )
         SELECT s.user_name
         FROM auth_sessions s
         JOIN users u ON u.name = s.user_name
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND NOT u.disabled`,
        [hashToken(token)],
      );
      return (rows[0]?.user_name as string | undefined) ?? null;
    },

    async revokeAuthSession(token) {
      const { rowCount } = await pool.query(
        "UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
        [hashToken(token)],
      );
      return (rowCount ?? 0) > 0;
    },

    async revokeAllAuthSessions(userName, exceptHash) {
      const { rowCount } = await pool.query(
        `UPDATE auth_sessions SET revoked_at = now()
         WHERE user_name = $1 AND revoked_at IS NULL
           AND ($2::text IS NULL OR token_hash <> $2)`,
        [userName, exceptHash ?? null],
      );
      return rowCount ?? 0;
    },
  };
};
