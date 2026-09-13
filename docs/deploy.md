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
   # admin plane bearer token (decision 13); unset value disables /admin
   SLOPWATCH_ADMIN_TOKEN=change-me-admin-token
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

1. Open `/#/admin`, sign in with `SLOPWATCH_ADMIN_TOKEN`.
2. Create the users (name + email), create the teams, assign each user to
   their team (decision 23 — unassigned users land in the "unassigned"
   bucket until filed).
3. Mint a token per user and hand it over out-of-band; each teammate runs
   `slopwatch install` (or `slopwatch login <token>`) against this server.
   The same token signs into the dashboard in the browser.

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
- **OIDC** is deliberately not in v2 — the first post-launch increment swaps
  the token issuer only (decision 6's upgrade path); nothing here changes.
- The compose Postgres credentials are intentionally simple defaults for the
  isolated compose network; change them if you attach the database to any
  other network.
