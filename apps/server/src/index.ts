import { loadConfig } from "./config";
import { createApp } from "./http";
import { createRetroQueue } from "./retrospective/queue";
import { createSummaryFold } from "./summary-fold";
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

// ADR 0008: the retrospective runner. Reconcile first — rows the previous
// process left open become failed runs a user can rerun; nothing resumes.
const stale = await store.failStaleRetros();
if (stale > 0)
  console.log(`marked ${stale} interrupted retrospective(s) failed`);
const retrospectives = createRetroQueue(store);
const summaryFold = createSummaryFold(store);

// The system pseudo-actor for audit entries the server itself causes (ADR
// 0007) — boot provisioning and prune sweeps. Best-effort like every append.
const systemAudit = (
  action: string,
  target: string,
  detail?: Record<string, unknown>,
): Promise<void> =>
  store
    .appendAudit({ actor: { kind: "system" }, action, target, detail })
    .catch((e: unknown) => console.error("audit append failed:", e));

// Role-based admin bootstrap: names in SLOPWATCH_ADMINS get the admin role
// idempotently at boot, so the first admin needs no operator-token dance.
for (const name of config.adminNames) {
  const before = await store.getUser(name);
  await store.ensureAdmin(name);
  if (before === null) {
    console.log(`admin role granted to "${name}"`);
    await systemAudit("user.provision", name, { via: "boot", role: "admin" });
  } else if (before.role !== "admin" || before.disabled) {
    console.log(`admin role granted to "${name}"`);
    await systemAudit("user.update", name, {
      via: "boot",
      changes: {
        ...(before.role !== "admin"
          ? { role: { before: before.role, after: "admin" } }
          : {}),
        ...(before.disabled
          ? { disabled: { before: true, after: false } }
          : {}),
      },
    });
  }
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
        // ADR 0007: the one automated mutation that rewrites stored data —
        // one summary entry per sweep keeps the trail complete.
        void systemAudit("events.prune", "events", { pruned, archived });
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
  retrospectives,
  summaryFold,
});

Bun.serve({
  port: config.port,
  fetch: (req) => app.fetch(req),
  // Any store throw that escapes a route lands here: answer a bare 500 and
  // log — never leak the exception text (it can carry SQL fragments) and
  // never let Bun's dev-mode default render it.
  error(e) {
    console.error("unhandled server error:", e);
    return new Response(JSON.stringify({ error: "internal error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  },
});
console.log(`slopwatch server listening on http://localhost:${config.port}`);
