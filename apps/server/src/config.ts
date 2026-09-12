export type Config = {
  port: number;
  databaseUrl: string;
  /** "name:token,name:token" → bearer token → user name. */
  tokens: Map<string, string>;
  /** Decision 13: admin plane bearer token; unset disables /admin/*. */
  adminToken: string | undefined;
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

  const s3Keys = [
    env.SLOPWATCH_S3_ENDPOINT,
    env.SLOPWATCH_S3_BUCKET,
    env.SLOPWATCH_S3_ACCESS_KEY_ID,
    env.SLOPWATCH_S3_SECRET_ACCESS_KEY,
  ];
  const s3 =
    s3Keys.every((v) => v !== undefined) &&
    s3Keys[0] &&
    s3Keys[1] &&
    s3Keys[2] &&
    s3Keys[3]
      ? {
          endpoint: s3Keys[0],
          bucket: s3Keys[1],
          accessKeyId: s3Keys[2],
          secretAccessKey: s3Keys[3],
          region: env.SLOPWATCH_S3_REGION ?? "us-east-1",
        }
      : null;

  return {
    port: Number(env.PORT ?? 8787),
    databaseUrl,
    tokens,
    adminToken: env.SLOPWATCH_ADMIN_TOKEN,
    rawTtlDays: Number(env.RAW_TTL_DAYS ?? 90),
    s3,
  };
};
