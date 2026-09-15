# Deploying Slopwatch for a team

The v2 deployment shape (decision 26) is one always-on intranet host running
three containers: the **Server** (API + dashboard), **Postgres**, and a
**MinIO** object store for the raw-payload cold archive (decision 24). The
compose file is the deliverable — a reinstall or host migration is one
command, not a procedure.

## Prerequisites

- Docker with the compose plugin on the target host.
- A hostname the team can reach (e.g. `slopwatch.internal`); put a
  TLS-terminating reverse proxy (nginx, Caddy, Traefik) in front of port
  8787 if the network is not fully trusted — reads are token-gated since
  v2 decision 22, but credentials over plain HTTP still travel in the clear.

## Bring-up

1. Prepare an environment file next to `docker-compose.yml`:

   ```sh
   cat > .env <<'EOF'
   # bootstrap ingest tokens, "name:token" pairs (v0 path, decision 6)
   SLOPWATCH_TOKENS=alice:change-me-alice-token,bob:change-me-bob-token
   # operator bypass for the admin plane (decision 13 + ADR 0006); optional
   # once real admins exist — the role, not this token, is the normal door
   SLOPWATCH_ADMIN_TOKEN=change-me-admin-token
   # users granted the admin role at boot (ADR 0006) — the first admin
   SLOPWATCH_ADMINS=alice
   # global raw-payload retention fallback in days (decision 11)
   RAW_TTL_DAYS=90
   # MinIO console/object-store password (8+ characters)
   MINIO_ROOT_PASSWORD=change-me-minio-password
   EOF
   chmod 600 .env
   ```

2. Build and start everything:

   ```sh
   docker compose up -d --build
   ```

   The Server runs its idempotent migrations at boot (tables, team columns,
   settings), then starts listening on 8787. `docker compose logs -f server`
   shows the startup banner.

3. Verify: `curl -fsS http://<host>:8787/healthz` answers `{"ok":true}` and
   the dashboard loads at `http://<host>:8787/` (anonymous until sign-in —
   every read needs a bearer token, decision 22).

## Onboarding the team

1. Open `/#/me` and sign in as one of the `SLOPWATCH_ADMINS` names — the
   admin role was granted at boot, and the admin panel opens with your user
   token (no second secret to paste; ADR 0006).
2. Create the users (name + email), create the teams, assign each user to
   their team (decision 23 — unassigned users land in the "unassigned"
   bucket until filed).
3. Mint a token per user and hand it over out-of-band; each teammate runs
   `slopwatch install` (or `slopwatch login <token>`) against this server.
   The same token signs into the dashboard in the browser. New users start
   with the member role — they see only their own sessions; promote someone
   from the users panel ("make admin") when they need the admin plane.

### OIDC instead of minted tokens (optional)

If the org runs an identity provider, set both variables in the compose
`.env` and restart:

```sh
SLOPWATCH_OIDC_ISSUER=https://idp.internal/realms/your-org
SLOPWATCH_OIDC_AUDIENCE=slopwatch
```

The server then also accepts RS256 JWTs the IdP issued (verified against its
published JWKS, ADR 0005). Identity maps onto users by the `email` claim,
then `preferred_username`/`sub`; a first sighting through the IdP provisions
the user row automatically — steps 1–3 shrink to assigning teams and DRIs in
the admin panel. Listeners keep sending a plain bearer token either way; an
IdP-issued token works for `slopwatch login` and the dashboard sign-in too.
Minted tokens remain valid alongside, so existing setups change nothing.

## Retention and archive

- Raw payloads expire on the ingesting session's team TTL override (the team
  is snapshotted at ingest per ADR 0004, so moving a member between teams
  never re-scopes their history), falling back to the owner's current team
  for sessions captured before v2, else `RAW_TTL_DAYS` (decision 11 + 24);
  the prune job runs at boot and daily.
- Expired payloads are archived to MinIO's `slopwatch-archive` bucket before
  deletion; each event row keeps `archive_key` so a payload stays fetchable
  by key — `GET /admin/archive?key=<archive_key>` (admin token) returns the
  stored payload verbatim. Back up the `minio-data` volume next to `db-data`.

## Operations notes

- **Backups**: `db-data` holds the normalized events (the truth);
  `minio-data` holds archived raw payloads. Both are plain Docker volumes.
- **Tokens**: rotating a bootstrap token means editing `.env` and
  `docker compose up -d`; admin-minted tokens rotate per user from the admin
  panel without a restart.
- **OIDC**: when `SLOPWATCH_OIDC_ISSUER`/`SLOPWATCH_OIDC_AUDIENCE` are set,
  the Server fetches the IdP's discovery document and JWKS lazily and caches
  them ~10 minutes — keep those URLs reachable from the container. A partial
  OIDC config fails the boot; a wrong issuer/audience surfaces as 401s on
  IdP-issued tokens only (ADR 0005).
- The compose Postgres credentials are intentionally simple defaults for the
  isolated compose network; change them if you attach the database to any
  other network.
