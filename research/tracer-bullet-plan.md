# Tracer Bullet Plan (v1 vertical slice)

**Status: COMPLETE (2026-09-09).** All five milestones shipped and verified end-to-end on Windows: 34 tests green, real client sessions auto-captured via the workspace hook, dashboard rendering live at `/`. Next up (in rough order): React SPA dashboard (decision 12), admin plane — token mint/revoke + session delete (decision 13), a second listener (claude-code), cost aggregation across providers, windows-latest in CI.

Goal: one end-to-end path — **ZCode session → Listener → Server → Postgres → polling page** — built in five milestones, each independently runnable and observable.

## Testing strategy

Layered, not blanket TDD:

1. **Unit tests are test-first** (`bun test`, red → green) for schema, normalization, and endpoint logic — everything with pure inputs/outputs.
2. **Integration and lifecycle behavior** (hook spawning, fs.watch tailing, sidecar exit, Postgres round-trip) cannot be honestly unit-tested; each gets a **smoke command** that runs the real artifact, and its raw output is pasted into the dev log every milestone. No "it works" without output.
3. **`bun run ci`** (format:check + tsgo typecheck + test) green before any milestone is called done.
4. **Real data over fixtures** where available — this machine has live ZCode rollout files, and the repo itself can be dogfooded.

## Milestones

### M1 — `NormalEvent` v0 (`packages/events`)

- **Scope**: discriminated union (`session`, `turn`, `model_request`, `tool`), `agent` as an open string (never a closed enum), `schema_version`, raw-payload escape hatch; `sendEvents` HTTP client (batched POST, bearer token).
- **Test-first**: valid/invalid event cases written before the implementation exists.
- **Minimal usage check**: a demo command parses one real line from `~/.zcode/cli/rollout/*.jsonl` and prints the normalized events as JSON — output shown in the dev log.
- **Done when**: ci green + demo output shown.

### M2 — ZCode Listener (`listeners/zcode`)

- **Scope**: replay mode (tail an existing rollout file) and live mode; the `SessionStart` process-hook spawner (detaches and returns immediately — ZCode hooks run inline); `Stop` + idle-timeout exit; per-session pipe names.
- **Test-first**: normalizer unit tests against committed fixtures cut from real rollout lines.
- **Minimal usage check**: `replay.ts <rollout-file>` prints normalized events; live mode prints while a session runs; exit-on-idle observed and shown.
- **Done when**: ci green + replay demo on real data + idle-exit demonstrated.

### M3 — Server + Postgres (`apps/server`)

- **Scope**: `POST /events` (bearer auth, per-session `event_seq`), `GET /sessions/:id/events?since_seq=`, daily raw-payload prune job (decision 11), env-only config. Requires the one open external dependency: a reachable Postgres.
- **Test-first**: endpoint tests against a test database — unauthorized 401, insert with monotonic seq, `since_seq` pagination.
- **Minimal usage check**: `bun run dev` + `curl` POST sample events + GET them back; the transcript is shown.
- **Done when**: ci green including DB tests + curl transcript shown + the open pg round-trip item closed.

### M4 — End-to-end dogfood

- **Scope**: `slopwatch install` for this repo — workspace config (`<repo>/.zcode/config.json`) with `hooks.enabled: true` and the `SessionStart` hook; events from real ZCode sessions in this repo flow to the Server.
- **Minimal usage check**: after install, any new ZCode session in this repo (including the agent's own work sessions) becomes queryable via the API — the dogfood loop.
- **Done when**: a real session's events are retrieved through the API; output shown.

### M5 — Bare polling page

- **Scope**: a server-served static page polling sessions + events, hand-written (the React SPA comes later — decision 12; the API is identical either way).
- **Minimal usage check**: open the URL in a browser, watch a live session update every ~5s.
- **Done when**: the page renders live data against the unchanged API.

## Dependency note

M1 and M2 need nothing external. M3 blocks on a reachable Postgres (connection string from the operator) — everything else can proceed while it is provisioned.
