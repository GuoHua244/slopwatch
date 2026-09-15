import { loadConfig } from "./config";
import { createApp } from "./http";
import { createPgStore } from "./store";
import { createS3Client } from "./s3";
import { createOidcVerifier } from "./oidc";
import { fileURLToPath } from "node:url";

const config = loadConfig();
if (config.tokens.size === 0) {
  console.warn(
    "warning: SLOPWATCH_TOKENS is empty — every POST /events will be rejected",
  );
}
if (config.adminToken === undefined) {
  console.warn(
    "warning: SLOPWATCH_ADMIN_TOKEN is unset — the operator bypass is off; " +
      "the admin plane stays open to users with the admin role " +
      "(grant the first one via SLOPWATCH_ADMINS)",
  );
}

const store = createPgStore(config.databaseUrl);
await store.migrate();

// Role-based admin bootstrap: names in SLOPWATCH_ADMINS get the admin role
// idempotently at boot, so the first admin needs no operator-token dance.
for (const name of config.adminNames) {
  await store.ensureAdmin(name);
  console.log(`admin role granted to "${name}"`);
}

// Decision 11 + v2 decision 24: expire raw payloads past their effective
// per-team TTL (and once at boot), archiving to the S3-compatible cold store
// when one is configured. The global default is the operator's stored
// raw_ttl_days setting, falling back to the boot-time env value.
const archive = config.s3 ? createS3Client(config.s3) : undefined;
const prune = () =>
  store
    .getSetting("raw_ttl_days")
    .then((days) =>
      store.pruneRaw({
        defaultDays: Number(days) || config.rawTtlDays,
        archive,
      }),
    )
    .then(({ archived, pruned }) => {
      if (pruned > 0) {
        console.log(
          `pruned raw payloads from ${pruned} events` +
            (archive ? ` (${archived} archived to object storage)` : ""),
        );
      }
    })
    .catch((e: unknown) => console.error("prune failed:", e));
void prune();
setInterval(prune, 24 * 60 * 60 * 1000);

// ADR 0005: the org IdP as a second token issuer. JWKS fetches happen lazily
// on first use, so boot never blocks on the IdP being reachable.
const oidc = config.oidc ? createOidcVerifier(config.oidc) : undefined;
if (config.oidc)
  console.log(
    `OIDC enabled — accepting RS256 tokens from ${config.oidc.issuer} (audience ${config.oidc.audience})`,
  );

// Decision 12: serve the built SPA same-origin from the single process.
const staticRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));

const app = createApp({
  tokens: config.tokens,
  store,
  staticRoot,
  adminToken: config.adminToken,
  defaultRawTtlDays: config.rawTtlDays,
  archive,
  oidc,
});

Bun.serve({ port: config.port, fetch: (req) => app.fetch(req) });
console.log(`slopwatch server listening on http://localhost:${config.port}`);
