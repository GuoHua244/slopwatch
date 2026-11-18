import { hashToken, type Store } from "../store";
import type { Audit } from "./audit";
import { bearerToken, type Reader } from "./auth";
import { json } from "./respond";
import { readJsonOr400, trimField } from "./validate";

/**
 * ADR 0011: password sign-in. The dashboard's human-facing door — a user
 * name and password exchanged once for a revocable session bearer that
 * rides every later request like any other token. Passwords are hashed with
 * Bun's argon2id (the store stores verbatim hashes, never hashes itself);
 * a user without a password signs in with their API token first and sets
 * one on the profile page or the first-run prompt.
 */

/**
 * A password is 8–200 characters, verbatim — never trimmed, because spaces
 * and leading/trailing whitespace are legitimate password content.
 */
export const parsePassword = (value: unknown): string | null =>
  typeof value === "string" && value.length >= 8 && value.length <= 200
    ? value
    : null;

/**
 * Verify a password against a hash no real password can match. Unknown
 * user names answer only after the same argon2 work a wrong password
 * costs, so response time never distinguishes "no such user".
 */
const DUMMY_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$PoJHwVwGBsHilpfY67MF8kTwieTHniNJxCoBnbTVqd4$uqgnnCIbfUBuMP4lYFUs5q3T4B+tT6mxZvvPQV8Q4Kw";

/** Per-name failed-attempt throttling for POST /auth/login. */
export type LoginGuardConfig = {
  /** Failures allowed before the lockout, within the window. */
  max: number;
  /** How long a lockout lasts (and failures are counted), ms. */
  windowMs: number;
  /** The pause before every failed answer — blunts scripted guessing. */
  failDelayMs: number;
};

export const DEFAULT_LOGIN_GUARD: LoginGuardConfig = {
  max: 10,
  windowMs: 15 * 60_000,
  failDelayMs: 250,
};

export type LoginGuard = {
  allow: (name: string) => boolean;
  fail: (name: string) => Promise<void>;
  reset: (name: string) => void;
};

/**
 * In-memory failure counter keyed by user name. Single-process deployments
 * only — the honest scope for this server; a lockout costs the attacker
 * `max` argon2 verifies per window and costs a fat-fingered human a few
 * minutes at worst.
 */
export const createLoginGuard = ({
  max,
  windowMs,
  failDelayMs,
}: LoginGuardConfig): LoginGuard => {
  const failures = new Map<string, { count: number; lockedUntil: number }>();
  const state = (name: string) => {
    const entry = failures.get(name);
    if (entry === undefined) {
      const fresh = { count: 0, lockedUntil: 0 };
      failures.set(name, fresh);
      return fresh;
    }
    // An expired lock starts counting anew; a counting entry (lockedUntil
    // 0) is never "expired", or the counter could never reach the max.
    if (entry.lockedUntil > 0 && entry.lockedUntil <= Date.now()) {
      entry.count = 0;
      entry.lockedUntil = 0;
    }
    return entry;
  };
  return {
    allow: (name) => state(name).count < max,
    fail: async (name) => {
      if (failDelayMs > 0)
        await new Promise((resolve) => setTimeout(resolve, failDelayMs));
      const entry = state(name);
      entry.count += 1;
      if (entry.count >= max) entry.lockedUntil = Date.now() + windowMs;
    },
    reset: (name) => {
      failures.delete(name);
    },
  };
};

/**
 * POST /auth/login — `{name, password}` for a session bearer. The error
 * bodies stay machine-coded (`invalid_credentials`, `password_not_set`)
 * so the sign-in page can speak plainly without the server leaking more
 * than intended: unknown name, wrong password, and disabled user all look
 * identical, and only the deliberate "no password yet" case names itself.
 */
export const handleAuthLogin = async (
  req: Request,
  { store, guard, audit }: { store: Store; guard: LoginGuard; audit: Audit },
): Promise<Response> => {
  const body = await readJsonOr400(req);
  const name = trimField(body.name, 100);
  const password = parsePassword(body.password);
  if (name === null || password === null)
    return json(400, {
      error: "name and an 8-200 character password are required",
    });
  if (!guard.allow(name))
    return json(429, {
      error: "too many failed attempts — wait a few minutes and try again",
    });
  const row = await store.getPasswordAuth(name);
  if (row === null || row.disabled) {
    // Spend the argon2 work a real user would cost before answering.
    await Bun.password.verify(password, DUMMY_HASH).catch(() => {});
    return json(401, { error: "invalid_credentials" });
  }
  if (row.passwordHash === null)
    return json(401, {
      error: "password_not_set",
      hint: "this account has no password yet — sign in once with your API token, then set a password",
    });
  if (!(await Bun.password.verify(password, row.passwordHash))) {
    await guard.fail(name);
    return json(401, { error: "invalid_credentials" });
  }
  guard.reset(name);
  const { token } = await store.createAuthSession(name);
  // The trail records the human door, not every token hello — one entry
  // per password login, attributable like every other mutation.
  await audit({ kind: "user", user: name }, "auth.login", name, {
    via: "password",
  });
  return json(200, { token, user: name });
};

/**
 * POST /auth/logout — revoke the bearer's session when it is one. Any other
 * bearer (an API token) is a no-op: log out never destroys an admin-minted
 * credential. Always 204 — logout is best-effort by contract.
 */
export const handleAuthLogout = async (
  req: Request,
  store: Store,
): Promise<Response> => {
  const bearer = bearerToken(req);
  if (bearer !== null) await store.revokeAuthSession(bearer);
  return new Response(null, { status: 204 });
};

/**
 * PUT /me/password — set the caller's password (first time, no current
 * needed) or change it (current required). Every *other* session dies so a
 * changed password actually locks other browsers out; the caller's own
 * session survives when the change was made from one.
 */
export const handleMePassword = async (
  req: Request,
  reader: Reader,
  { store, audit }: { store: Store; audit: Audit },
): Promise<Response> => {
  const body = await readJsonOr400(req);
  const newPassword = parsePassword(body.new_password);
  if (newPassword === null)
    return json(400, {
      error: "new_password must be a string of 8-200 characters",
    });
  const row = await store.getPasswordAuth(reader.user);
  if (row === null) return json(404, { error: "no such user" });
  const wasSet = row.passwordHash !== null;
  if (row.passwordHash !== null) {
    const current =
      typeof body.current_password === "string" ? body.current_password : null;
    if (current === null)
      return json(400, {
        error: "current_password is required when a password is already set",
      });
    if (!(await Bun.password.verify(current, row.passwordHash)))
      return json(400, { error: "current_password does not match" });
  }
  await store.setPasswordHash(
    reader.user,
    await Bun.password.hash(newPassword),
  );
  // The caller's bearer is spared by hash non-match — which spares their
  // session when they signed in with one, and nothing when they signed in
  // with an API token (whose hash is no session's).
  const bearer = bearerToken(req) ?? "";
  await store.revokeAllAuthSessions(reader.user, hashToken(bearer));
  await audit(
    { kind: "user", user: reader.user },
    wasSet ? "auth.password.change" : "auth.password.set",
    reader.user,
  );
  return json(200, { ok: true });
};
