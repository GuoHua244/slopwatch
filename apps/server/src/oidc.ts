import { createPublicKey, createVerify, type KeyObject } from "node:crypto";

/**
 * The JWK fields an RSA signing key carries. node:crypto's own JsonWebKey
 * type hides in its crypto namespace, which not every TS setup resolves —
 * this structural subset is all RS256 verification needs.
 */
type Jwk = {
  kty?: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
};

/** Claims the identity mapping needs (OIDC Core 5.1). */
export type OidcIdentity = {
  subject: string;
  email: string | null;
  preferredUsername: string | null;
  name: string | null;
};

export type OidcVerifier = {
  /**
   * The token's claims when it carries a signature and claims from the
   * configured issuer; null for anything else — never throws, an
   * authentication failure answers 401 like any other bad credential.
   */
  verify(token: string): Promise<OidcIdentity | null>;
};

export type OidcOptions = {
  issuer: string;
  audience: string;
  /** Injectable for tests; defaults to global fetch + res.json(). */
  fetchJson?: (url: string) => Promise<unknown>;
  /** JWKS cache lifetime, refreshed early on an unknown kid. Default 10 min. */
  jwksTtlMs?: number;
};

/** Clock leeway for exp/nbf, seconds — small IdP skews are normal. */
const LEEWAY_S = 60;

type Header = { alg: string; kid?: string };

const decodeSegment = <T>(segment: string): T | null => {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
};

const strClaim = (
  claims: Record<string, unknown>,
  key: string,
): string | null => {
  const v = claims[key];
  return typeof v === "string" && v.length > 0 ? v : null;
};

const defaultFetchJson = async (url: string): Promise<unknown> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`);
  return res.json();
};

/**
 * ADR 0005: the org IdP as a second token issuer. RS256 JWTs are verified
 * against the issuer's JWKS (located via discovery, cached, refreshed on an
 * unknown kid); iss/aud/exp/nbf are checked; everything else about the token
 * shape is untouched — the listener still sends a plain bearer token.
 */
export const createOidcVerifier = ({
  issuer,
  audience,
  fetchJson = defaultFetchJson,
  jwksTtlMs = 10 * 60_000,
}: OidcOptions): OidcVerifier => {
  let jwksUri: string | null = null;
  let keys: Jwk[] = [];
  let keysFetchedAt = 0;

  const loadDiscovery = async (): Promise<string> => {
    if (jwksUri !== null) return jwksUri;
    const doc = (await fetchJson(
      `${issuer}/.well-known/openid-configuration`,
    )) as { issuer?: unknown; jwks_uri?: unknown };
    if (doc.issuer !== issuer || typeof doc.jwks_uri !== "string")
      throw new Error(
        "discovery document does not match the configured issuer",
      );
    jwksUri = doc.jwks_uri;
    return jwksUri;
  };

  const loadKeys = async (force: boolean): Promise<Jwk[]> => {
    if (!force && keys.length > 0 && Date.now() - keysFetchedAt < jwksTtlMs)
      return keys;
    const doc = (await fetchJson(await loadDiscovery())) as { keys?: unknown };
    if (!Array.isArray(doc.keys)) throw new Error("JWKS carries no keys array");
    keys = doc.keys as Jwk[];
    keysFetchedAt = Date.now();
    return keys;
  };

  const signingKey = (jwks: Jwk[], kid: string | undefined): Jwk | null => {
    if (kid === undefined) return jwks.length === 1 ? jwks[0]! : null;
    return jwks.find((k) => k.kid === kid) ?? null;
  };

  const rs256Valid = (
    signedPart: string,
    signature: Buffer,
    jwk: Jwk,
  ): boolean => {
    try {
      if (jwk.kty !== "RSA") return false;
      const key = createPublicKey({ key: jwk, format: "jwk" });
      return createVerify("RSA-SHA256")
        .update(signedPart)
        .verify(key, signature);
    } catch {
      return false;
    }
  };

  return {
    async verify(token) {
      try {
        const parts = token.split(".");
        if (parts.length !== 3) return null;
        const [head, body, sig] = parts as [string, string, string];
        const header = decodeSegment<Header>(head);
        if (header === null || header.alg !== "RS256") return null;
        const claims = decodeSegment<Record<string, unknown>>(body);
        if (claims === null) return null;

        const nowS = Date.now() / 1000;
        if (claims.iss !== issuer) return null;
        const aud = claims.aud;
        if (aud !== audience && !(Array.isArray(aud) && aud.includes(audience)))
          return null;
        if (typeof claims.exp !== "number") return null;
        if (claims.exp + LEEWAY_S < nowS) return null;
        if (typeof claims.nbf === "number" && claims.nbf - LEEWAY_S > nowS)
          return null;
        const subject = strClaim(claims, "sub");
        if (subject === null) return null;

        let jwks = await loadKeys(false);
        let key = signingKey(jwks, header.kid);
        if (key === null) {
          // An unknown kid usually means the IdP rotated keys — refresh once.
          jwks = await loadKeys(true);
          key = signingKey(jwks, header.kid);
        }
        if (key === null) return null;
        const signature = Buffer.from(sig, "base64url");
        if (!rs256Valid(`${head}.${body}`, signature, key)) return null;

        return {
          subject,
          email: strClaim(claims, "email"),
          preferredUsername: strClaim(claims, "preferred_username"),
          name: strClaim(claims, "name"),
        };
      } catch {
        // IdP unreachable, discovery mismatch, malformed anything.
        return null;
      }
    },
  };
};
