import { describe, expect, test } from "bun:test";
import {
  createHmac,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { createOidcVerifier, type OidcVerifier } from "./oidc";

// ADR 0005: the verifier is the whole security boundary of the OIDC path, so
// the tests are full-cycle — real RSA keys, real signatures, fake IdP URLs.
const ISSUER = "https://idp.example.com";
const AUDIENCE = "slopwatch";

const b64url = (input: string | Buffer): string =>
  Buffer.from(input).toString("base64url");

const firstKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const secondKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwkOf = (publicKey: KeyObject, kid: string) => ({
  ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>),
  kid,
  alg: "RS256",
  use: "sig",
});

const mint = (
  claims: Record<string, unknown>,
  opts: {
    key?: KeyObject;
    kid?: string;
    header?: Record<string, unknown>;
  } = {},
): string => {
  const head = b64url(
    JSON.stringify({
      alg: "RS256",
      typ: "JWT",
      kid: opts.kid ?? "k1",
      ...(opts.header ?? {}),
    }),
  );
  const body = b64url(JSON.stringify(claims));
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${head}.${body}`),
    opts.key ?? firstKey.privateKey,
  );
  return `${head}.${body}.${b64url(signature)}`;
};

const baseClaims = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  iss: ISSUER,
  aud: AUDIENCE,
  sub: "user-1",
  exp: Math.floor(Date.now() / 1000) + 300,
  email: "user1@corp.dev",
  preferred_username: "user.one",
  name: "User One",
  ...overrides,
});

let jwksKeys = [jwkOf(firstKey.publicKey, "k1")];
let jwksFetches = 0;
const fetchJson = async (url: string): Promise<unknown> => {
  if (url === `${ISSUER}/.well-known/openid-configuration`)
    return { issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` };
  if (url === `${ISSUER}/jwks`) {
    jwksFetches++;
    return { keys: jwksKeys };
  }
  throw new Error(`unexpected fetch ${url}`);
};

const verifier = (): OidcVerifier =>
  createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE, fetchJson });

describe("OIDC token verification (ADR 0005)", () => {
  test("a valid token yields the identity claims", async () => {
    const id = await verifier().verify(mint(baseClaims()));
    expect(id).toEqual({
      subject: "user-1",
      email: "user1@corp.dev",
      preferredUsername: "user.one",
      name: "User One",
    });
  });

  test("an audience array containing the audience passes", async () => {
    const id = await verifier().verify(
      mint(baseClaims({ aud: ["other-client", AUDIENCE] })),
    );
    expect(id?.subject).toBe("user-1");
  });

  test("a wrong issuer is rejected", async () => {
    expect(
      await verifier().verify(
        mint(baseClaims({ iss: "https://evil.example" })),
      ),
    ).toBeNull();
  });

  test("a wrong audience is rejected", async () => {
    expect(
      await verifier().verify(mint(baseClaims({ aud: "other-client" }))),
    ).toBeNull();
  });

  test("an expired token is rejected", async () => {
    expect(
      await verifier().verify(
        mint(baseClaims({ exp: Math.floor(Date.now() / 1000) - 3600 })),
      ),
    ).toBeNull();
  });

  test("a not-yet-valid token is rejected", async () => {
    expect(
      await verifier().verify(
        mint(baseClaims({ nbf: Math.floor(Date.now() / 1000) + 3600 })),
      ),
    ).toBeNull();
  });

  test("a token without exp is rejected", async () => {
    const { exp, ...withoutExp } = baseClaims();
    expect(await verifier().verify(mint(withoutExp))).toBeNull();
  });

  test("a token without sub is rejected", async () => {
    const { sub, ...withoutSub } = baseClaims();
    expect(await verifier().verify(mint(withoutSub))).toBeNull();
  });

  test("alg=none is rejected without touching the JWKS", async () => {
    const head = b64url(JSON.stringify({ alg: "none" }));
    const body = b64url(JSON.stringify(baseClaims()));
    expect(await verifier().verify(`${head}.${body}.`)).toBeNull();
  });

  test("an HS256 token is rejected", async () => {
    const head = b64url(JSON.stringify({ alg: "HS256", kid: "k1" }));
    const body = b64url(JSON.stringify(baseClaims()));
    const sig = createHmac("sha256", "shared-secret")
      .update(`${head}.${body}`)
      .digest();
    expect(
      await verifier().verify(`${head}.${body}.${b64url(sig)}`),
    ).toBeNull();
  });

  test("a token signed by the wrong key is rejected", async () => {
    expect(
      await verifier().verify(
        mint(baseClaims(), { key: secondKey.privateKey }),
      ),
    ).toBeNull();
  });

  test("garbage is rejected", async () => {
    expect(await verifier().verify("not-a-token")).toBeNull();
    expect(await verifier().verify("a.b.c")).toBeNull();
    expect(await verifier().verify("")).toBeNull();
  });

  test("a tampered payload is rejected", async () => {
    const token = mint(baseClaims());
    const [head, , sig] = token.split(".");
    const forgedBody = b64url(JSON.stringify(baseClaims({ sub: "admin-1" })));
    expect(await verifier().verify(`${head}.${forgedBody}.${sig}`)).toBeNull();
  });

  test("a mismatched discovery issuer is rejected", async () => {
    const v = createOidcVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      fetchJson: async () => ({
        issuer: "https://other.example",
        jwks_uri: "x",
      }),
    });
    expect(await v.verify(mint(baseClaims()))).toBeNull();
  });

  test("an unreachable IdP is an auth failure, not a crash", async () => {
    const v = createOidcVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      fetchJson: async () => {
        throw new Error("connection refused");
      },
    });
    expect(await v.verify(mint(baseClaims()))).toBeNull();
  });

  test("the JWKS is cached across verifications", async () => {
    jwksFetches = 0;
    const v = verifier();
    expect(await v.verify(mint(baseClaims()))).not.toBeNull();
    expect(await v.verify(mint(baseClaims()))).not.toBeNull();
    expect(jwksFetches).toBe(1);
  });

  test("an unknown kid forces a JWKS refresh and survives key rotation", async () => {
    jwksFetches = 0;
    jwksKeys = [jwkOf(firstKey.publicKey, "k1")];
    const v = verifier();
    expect(await v.verify(mint(baseClaims()))).not.toBeNull();

    // the IdP rotates: only k2 exists now; in-flight cached keys miss
    jwksKeys = [jwkOf(secondKey.publicKey, "k2")];
    const rotated = mint(baseClaims(), {
      key: secondKey.privateKey,
      kid: "k2",
    });
    const before = jwksFetches;
    expect(await v.verify(rotated)).not.toBeNull();
    expect(jwksFetches).toBeGreaterThan(before);
  });

  test("a kid naming no key after refresh is rejected", async () => {
    jwksKeys = [jwkOf(firstKey.publicKey, "k1")];
    const v = verifier();
    const unknownKid = mint(baseClaims(), { kid: "no-such-key" });
    expect(await v.verify(unknownKid)).toBeNull();
  });
});
