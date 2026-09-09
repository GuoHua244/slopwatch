export type Config = {
  port: number;
  databaseUrl: string;
  /** "name:token,name:token" → bearer token → user name. */
  tokens: Map<string, string>;
  /** Decision 13: admin plane bearer token; unset disables /admin/*. */
  adminToken: string | undefined;
  /** Decision 11: raw payload TTL in days. */
  rawTtlDays: number;
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

  return {
    port: Number(env.PORT ?? 8787),
    databaseUrl,
    tokens,
    adminToken: env.SLOPWATCH_ADMIN_TOKEN,
    rawTtlDays: Number(env.RAW_TTL_DAYS ?? 90),
  };
};
