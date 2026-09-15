export type Config = {
  port: number;
  databaseUrl: string;
  /** "name:token,name:token" → bearer token → user name. */
  tokens: Map<string, string>;
  /** Decision 13: admin plane bearer token; unset removes the bypass only —
   * role-based admins (users.role = 'admin') always keep the plane open. */
  adminToken: string | undefined;
  /** Names granted the admin role at boot (SLOPWATCH_ADMINS), the
   * bootstrap path to the first admin. */
  adminNames: string[];
  /** Decision 11: raw payload TTL in days. */
  rawTtlDays: number;
  /** v2 decision 24: the S3-compatible cold archive; null = archiving off. */
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  } | null;
  /** ADR 0005: the org IdP as a second token issuer; null = minted only. */
  oidc: { issuer: string; audience: string } | null;
};

export const loadConfig = (
  env: Record<string, string | undefined> = process.env,
): Config => {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const tokens = new Map<string, string>();
  for (const pair of (env.SLOPWATCH_TOKENS ?? "").split(",")) {
    const idx = pair.indexOf(":");
    if (idx > 0)
      tokens.set(pair.slice(idx + 1).trim(), pair.slice(0, idx).trim());
  }

  // v2 decision 21 ethos: fail visible — a partial S3 config must not silently
  // disable archiving while payloads quietly pile up in Postgres.
  const s3Required = [
    env.SLOPWATCH_S3_ENDPOINT,
    env.SLOPWATCH_S3_BUCKET,
    env.SLOPWATCH_S3_ACCESS_KEY_ID,
    env.SLOPWATCH_S3_SECRET_ACCESS_KEY,
  ];
  const missing = s3Required.filter((v) => !v).length;
  if (missing > 0 && missing < s3Required.length)
    throw new Error(
      "S3 archive partially configured — set all of SLOPWATCH_S3_ENDPOINT, SLOPWATCH_S3_BUCKET, SLOPWATCH_S3_ACCESS_KEY_ID, SLOPWATCH_S3_SECRET_ACCESS_KEY, or none",
    );
  const s3 =
    missing === 0
      ? {
          endpoint: env.SLOPWATCH_S3_ENDPOINT!,
          bucket: env.SLOPWATCH_S3_BUCKET!,
          accessKeyId: env.SLOPWATCH_S3_ACCESS_KEY_ID!,
          secretAccessKey: env.SLOPWATCH_S3_SECRET_ACCESS_KEY!,
          region: env.SLOPWATCH_S3_REGION ?? "us-east-1",
        }
      : null;

  // ADR 0005, the same fail-visible ethos as the S3 block above: half an
  // OIDC config would 401 every IdP-issued login with no hint why.
  const oidcValues = [env.SLOPWATCH_OIDC_ISSUER, env.SLOPWATCH_OIDC_AUDIENCE];
  const oidcMissing = oidcValues.filter((v) => !v).length;
  if (oidcMissing > 0 && oidcMissing < oidcValues.length)
    throw new Error(
      "OIDC partially configured — set both SLOPWATCH_OIDC_ISSUER and SLOPWATCH_OIDC_AUDIENCE, or none",
    );
  const oidc =
    oidcMissing === 0
      ? {
          issuer: env.SLOPWATCH_OIDC_ISSUER!,
          audience: env.SLOPWATCH_OIDC_AUDIENCE!,
        }
      : null;

  return {
    port: Number(env.PORT ?? 8787),
    databaseUrl,
    tokens,
    adminToken: env.SLOPWATCH_ADMIN_TOKEN,
    adminNames: (env.SLOPWATCH_ADMINS ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
    rawTtlDays: Number(env.RAW_TTL_DAYS ?? 90),
    s3,
    oidc,
  };
};
