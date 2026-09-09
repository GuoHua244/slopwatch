# slopwatch

Self-hosted, on-prem observability platform for coding agents. See
[`research/v1-architecture-decisions.md`](./research/v1-architecture-decisions.md)
and [`CONTEXT.md`](./CONTEXT.md) for the architecture and glossary.

## Layout

- `apps/server` — the Server: receives events from Listeners, stores them in
  Postgres, serves the read-only dashboard API.
- `apps/web` — the dashboard SPA (React + Vite). Dev server proxies the API;
  the production build is meant to be embedded into the Server binary.
- `packages/events` — the Listener→Server event contract (`NormalEvent`,
  `sendEvents`).
- `listeners/*` — per-agent Listeners.

## Running the dashboard locally

1. Start the Server (needs `DATABASE_URL`; see `.env.example`):

   ```
   bun apps/server/src/index.ts   # listens on :8787
   ```

2. Start the dashboard dev server in a second terminal:

   ```
   cd apps/web
   bun run dev                    # listens on :5173, proxies /sessions and /healthz
   ```

3. Open http://localhost:5173 — sessions list, turn view, raw event log,
   per-session usage, and the developer leaderboard all poll live.

## Quality gate

`bun run ci` (prettier, tsgo, bun test across every workspace) must pass
before a milestone is called done.
