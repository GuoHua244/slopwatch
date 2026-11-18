import { createHash, timingSafeEqual } from "node:crypto";
import type { OidcVerifier } from "../oidc";
import type { Role, Store } from "../store";
import { HttpError, json } from "./respond";

export const bearerToken = (req: Request): string | null => {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
};

/** Length-independent constant-time secret comparison (digest both sides). */
export const timingSafeTokenEq = (a: string, b: string): boolean => {
  if (a.length === 0 || b.length === 0) return false;
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
};

/** The signed-in reader plus their authorization role. */
export type Reader = { user: string; role: Role };

export type Auth = {
  /** Signed-in user name, or null when no bearer token resolves. */
  resolveUser(req: Request): Promise<string | null>;
  /** The reader, or null when no bearer token resolves. */
  resolveReader(req: Request): Promise<Reader | null>;
  /** The signed-in user name, or the thrown 401 sentinel. */
  requireUser(req: Request): Promise<string>;
  /** The reader, or the thrown 401 sentinel. */
  requireReader(req: Request): Promise<Reader>;
};

/**
 * Token resolution for one app instance: env tokens first (v0 bootstrap),
 * then admin-minted tokens (decision 6), then password-login sessions
 * (ADR 0011), then IdP-issued JWTs (ADR 0005).
 */
export const createAuth = ({
  tokens,
  store,
  oidc,
}: {
  tokens: Map<string, string>;
  store: Store;
  oidc?: OidcVerifier;
}): Auth => {
  const resolveUser = async (req: Request): Promise<string | null> => {
    const bearer = bearerToken(req);
    if (bearer === null) return null;
    const minted = tokens.get(bearer) ?? (await store.resolveTokenUser(bearer));
    if (minted !== null) {
      // resolveTokenUser excludes disabled users in SQL; the env-map path
      // bypasses that check, so consult the row (absent = never
      // provisioned → v0 semantics keep working, first /me provisions).
      const row = await store.getUser(minted);
      if (row?.disabled) return null;
      return minted;
    }
    const session = await store.resolveAuthSession(bearer);
    if (session !== null) return session;
    const identity = oidc === undefined ? null : await oidc.verify(bearer);
    if (identity === null) return null;
    return store.resolveOidcUser(identity);
  };

  // Role-based reads: members see only their own rows; admins see the org
  // (decision: role plane). One extra primary-key lookup per read is the
  // whole cost.
  const resolveReader = async (req: Request): Promise<Reader | null> => {
    const user = await resolveUser(req);
    if (user === null) return null;
    return { user, role: await store.roleOf(user) };
  };

  const unauthorized = (): HttpError =>
    new HttpError(json(401, { error: "unauthorized" }));

  const requireUser = async (req: Request): Promise<string> => {
    const user = await resolveUser(req);
    if (user === null) throw unauthorized();
    return user;
  };

  const requireReader = async (req: Request): Promise<Reader> => {
    const reader = await resolveReader(req);
    if (reader === null) throw unauthorized();
    return reader;
  };

  return { resolveUser, resolveReader, requireUser, requireReader };
};
