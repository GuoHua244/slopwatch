# slopwatch

Self-hosted, on-prem observability platform for coding agents.

> **The idea is not mine.** Slopwatch was conceived — named, scoped, and
> architected — by [Matt Pocock](https://github.com/mattpocock) in
> [mattpocock/slopwatch](https://github.com/mattpocock/slopwatch). This
> repository is an independent implementation that follows the idea and the
> direction he laid out; the code, decisions, and add-on features here
> (teams, retrospectives, feedback, password sign-in, and the per-agent
> listeners) are ours, but the concept belongs to him.

Sign in with a user name and password; an admin mints an API token
(`sw_…`) for the first sign-in and for tools and scripts — the sign-in page
has a token door that also walks a first-time user through setting their own
password.

See [`research/v1-architecture-decisions.md`](./research/v1-architecture-decisions.md),
[`research/v2-plan.md`](./research/v2-plan.md),
[`research/v3-plan.md`](./research/v3-plan.md), and
[`CONTEXT.md`](./CONTEXT.md) for the architecture and glossary.

## MCP endpoint

The Server exposes a read-only
[MCP](https://modelcontextprotocol.io) endpoint at `POST /mcp` (streamable
HTTP, one JSON-RPC request per call, your existing bearer token as the
credential). Tools: `get_session`, `list_recent_sessions`,
`list_session_events`, `list_session_commits`, `get_usage` — all read-only,
scoped exactly like the dashboard (members see only their own rows; admins
read org-wide). Point any MCP client at `http://<server>:8787/mcp` with the
`Authorization: Bearer` header.

## Layout

- `apps/server` — the Server: receives events from Listeners, stores them in
  Postgres, serves the dashboard API.
- `apps/web` — the dashboard SPA (React + Vite). Dev server proxies the API;
  the production build is baked into the Server container.
- `packages/events` — the Listener→Server event contract (`NormalEvent`,
  `sendEvents`).
- `listeners/*` — per-agent Listeners (Claude Code, ZCode, CodeBuddy, Codex).

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
before a milestone is called done. Tests that need Postgres read
`DATABASE_URL_TEST` and skip cleanly when it is absent.

## License

[Apache License 2.0](./LICENSE).
