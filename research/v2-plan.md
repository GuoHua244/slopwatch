# Slopwatch v2 Plan — Team Rollout

**Status: SHIPPED (2026-09-13).** M0–M3 implemented, tested, and verified end-to-end on the dev deployment (real ZCode session captured through the new pipeline; live dashboard verified in the browser). Decisions 20–27 as settled in the design interview; implementation refinements recorded in "Landed" notes per decision and in the amendment list at the bottom. Decision numbering continues the ledger in [`v1-architecture-decisions.md`](./v1-architecture-decisions.md), which ends at 19. Companions: [`../CONTEXT.md`](../CONTEXT.md) (glossary — `Team` is defined there), ADR 0003 (authenticated reads) and ADR 0004 (team attribution) in [`../docs/adr/`](../docs/adr), and [`../docs/deploy.md`](../docs/deploy.md) (compose deployment).

Goal: turn Slopwatch from a single-operator deployment into something a real team can be onboarded onto — protected reads, team-shaped reporting, retention policy, a deployable artifact, and capture that does not silently lose data.

---

## Decisions

### 20. Positioning: v2 ships a team rollout

The success criterion is one real team onboarded onto a self-hosted Server. v1 ran with a single user and env-bootstrap tokens, so every deferred multi-user concern — identity friction, read exposure, per-team reporting and retention, a hand-off-able deployment — is now load-bearing. Everything serving that onboarding is in scope (21–27); everything else keeps its v1 deferral (see "Out of scope").

**Listener coverage stays ZCode + Claude Code.** Coverage follows what the team actually runs; adapters for agents nobody uses yet are blind-written. New listeners (Codex, Pi, OpenCode, Copilot) return to the backlog when the team's agent census says otherwise.

### 21. Robustness debt lands first: drift quarantine and a disk-backed offline buffer

This is the M0 milestone and a launch blocker — both mechanisms are "build it in before more capture depends on it."

- **Schema drift (closes v1 open question 6).** Each adapter declares the rollout/JSONL versions it supports. Lines that parse ingest as usual; lines that do not are written verbatim to a quarantine store with per-agent counters, surfaced on the admin health page. **Fail open, but visible.** Rejected: fail closed — an agent upgrade would silently starve the whole team's dashboard until someone notices the stale date; plain fail open — dropped lines are undetectable, which is today's failure mode with better grammar.
- **Offline buffer (closes the buffering half of v1 open question 4, and decision 19's still-open whole-session loss).** When `POST /events` fails, the sidecar appends the events to a local disk queue file beside its cursor and replays them in order once the Server is reachable again. The queue has size and age caps; overflow drops oldest and ships a drop counter that lands on the health page. Rejected: a memory-only queue — a reboot or a laptop lid closes erases it, so it protects against nothing; sqlite-backed storage — a new dependency for little gain over append-only JSONL.

### 22. Reads require tokens: the anonymous-read surface closes

All read routes and the dashboard SPA require a bearer token from v2's M1; `/healthz` stays anonymous as an ops endpoint. The browser asks once for a user token, stores it in localStorage, and sends it on every request — the mechanism the admin plane already uses. Every team member already holds a token because their Listener needs one, so this adds zero new infrastructure, and the later OIDC switch changes only the issuer, not this surface (v1 decision 6's upgrade path, unchanged).

**Why.** Once the Server lives on a shared intranet host, anonymous reads mean any device on the network — visitor laptops, printers, anything that joins — can enumerate sessions and read raw model I/O, i.e. colleagues' prompt and completion text. v1's anonymous reads were a deliberate trade for a single-operator box; the trade flips when the audience becomes a team. See ADR 0003.

**Rejected.** Anonymous aggregates with token-gated details: two auth tiers over one secret system to save each user one paste — and every token-holder is a legitimate full reader anyway.

### 23. Team entity: one team per User; sessions snapshot their team at creation

- A **User** belongs to exactly one **Team** (a nullable foreign key — no membership table). One membership means every consumer — leaderboard grouping, DRI filtering, retention — reads its scope straight off the user; no tie-break rules anywhere.
- A **Session** records the `team_id` its User belonged to at session creation. Usage is counted where it happened: reorganizations never rewrite history, and team rollups aggregate without read-time reinterpretation. The scenario that decided it: a developer spends 40M tokens in team A in September and moves to team B in October — September's team-A report must still show 40M.
- **DRI stays org-wide** (v1 decision 10's shape, unchanged). Team-scoped DRIs need a real org that wants them; the stored `team_id` makes that filter a trivial later increment.
- **Existing data migrates by doing nothing**: nullable team plus an "unassigned" bucket in the leaderboard and filters; the admin assigns people through the team-configuration UI as part of onboarding. No backfill script, no synthetic default team that would linger as a junk drawer.
- The leaderboard gains the **team column** (closing the still-open note on v1 decision 18).

**Rejected.** Live join at read time — reports would follow people across reorgs and month-end reconciliation would become impossible (ADR 0004). Multi-team membership — real flexibility, purchased with an ambiguity tax in every consumer, before any real multi-team user exists.

### 24. Retention: per-team TTL over the global default, plus S3-compatible cold archive

A Team may set its own raw-payload retention window overriding the global default (v1 decision 11's 90 days remains the fallback); the daily prune job reads the effective policy per session's team. Payloads leaving their window are archived to an S3-compatible object store before deletion. The archive speaks the S3 interface only — endpoint and credentials via env; **MinIO ships in the compose file** so self-hosted deployments gain no cloud dependency. Restore is out of scope for v2: objects are raw payloads verbatim, fetchable by key; rehydration tooling waits for a real need.

### 25. Push notifications: one org-level webhook

The admin configures a single webhook URL; finished sessions push a message in a generic bot format (Feishu/DingTalk/Slack-style incoming-webhook payloads). Per-user channels and subscription preferences are out — the point is that DRIs will not poll a firehose during rollout, and pull-to-push is the additive direction (v1 decision 10); the reverse is not.

### 26. Deployment: Docker Compose on an always-on intranet host

The deliverable is a compose file — Server, Postgres, MinIO — plus a deployment doc; the operator provides a host, a hostname, and volume directories. Deployment becomes a copyable artifact instead of hand-run steps. Development stays Windows-native (ADR 0001 governs the dev experience, not the ops shape).

**Rejected.** A Windows service on a bare machine (a procedure, not an artifact — unreproducible after a reinstall); running the Server on a developer's machine (the whole team's data availability becomes that machine's uptime).

### 27. Display-layer timezone boundaries and leaderboard controls

Storage and rollup buckets stay UTC (v1 decision 18 stands). Daily aggregates render in the browser's local timezone. For a single-timezone team this is a correctness fix, not polish: in UTC+8, UTC day boundaries put 08:00 into "yesterday," so every "daily" number is quietly mislabeled. Sort/filter controls ship with the team-column work rather than as a separate pass.

### 28. Summary folds execute on the server, on the caller's own profile credentials

The rolling Summary's LLM call moves off the observed machine (ADR 0010): the listener ships the fold prompt to `POST /summary/fold`, and the Server executes it with the caller's own profile LLM credentials — the same config Retrospectives run on, so one place stores endpoint, model, key, and any plan-specific endpoint semantics. A user without credentials gets no summary at all (silent skip, digests kept). The per-machine `summary` config block and the install `--summary-*` flags are removed; ADR 0008's write-only key rule holds because the key never leaves the server.

---

## Out of scope for v2

- **OIDC** — shipped 2026-09-14 as ADR 0005: the server accepts RS256 JWTs
  from a configured issuer alongside minted tokens; the token shape did not
  change (v1 decision 6). The team filter the plan called a trivial later
  increment shipped the same day — `GET /sessions?team_id=` on the stored
  session snapshot.
- **New listeners** — Codex, Pi, OpenCode, Copilot stay deferred (decision 20).
- **Cross-provider cost normalization** — reaffirmed deferred (v1 open question 12): token totals are stored and serve relative comparison; a price table would be a permanently maintained asset the rollout does not depend on.
- **Resident helper process, sub-5s spectate, proxy capture path, resumes/compaction modeling** — unchanged deferrals; revisit triggers unchanged.
- **Tail resync across rollout rewrites** — a same-or-larger rewrite can resume the tail mid-record and quarantine a suffix (research/quarantine-rewrite-suffixes.md); a resync protocol needs dedup groundwork, deferred until the artifacts cost more than the fix.

## Future iteration candidates

Post-launch ideas recorded without commitment; each graduates to a plan and an ADR when picked up.

- **Feedback channel** (logged 2026-09-25 as session bug reports; designed 2026-09-25, see docs/adr/0009-feedback.md; not scheduled) — the generalization of that idea: any signed-in User files a **Feedback** from the dashboard (a session-anchored defect or a global feature suggestion — five kinds, optional attachments), and the admin plane lists and deletes it; stateless by design.

## Known-bug gate

The intermittent hook non-fire observed during acceptance (2026-09-11) was root-caused afterwards (v1 decision 19): the hooks never miss a user message — the losses happen after the sidecar's idle-timeout exit mid-turn, when nothing re-spawns it until the next prompt. The PostToolUse re-spawn fix (2026-09-12) addresses the cause; M0 still holds a gate — reproduce the acceptance scenario that caught the loss and land a regression test before launch.

---

## Milestones

Each milestone ends runnable and observable; `bun run ci` green before any of it is called done.

### M0 — Stabilization

- **Scope**: hook-loss fix verification — the root cause is already found (decision 19); reproduce the acceptance miss and add a regression test; drift quarantine (decision 21); disk-backed offline buffer (decision 21).
- **Done when**: a killed Server demonstrably loses nothing (buffer replays on recovery, counters visible); a mutated rollout line lands in quarantine with a health-page counter; the hook bug has a root cause and a regression test.
- **Blocks launch.**

### M1 — Team entity and protected reads

- **Scope**: teams table, `users.team_id`, session team snapshot (decision 23); token-gated reads and SPA token entry (decision 22); admin UI team assignment.
- **Done when**: a fresh deployment serves no data without a token; the leaderboard shows the team column with an unassigned bucket; existing sessions appear unassigned and assigning a user files their new sessions under the team.

### M2 — Team reporting and retention

- **Scope**: per-team TTL and archive-before-prune against a dev MinIO (decision 24); leaderboard sort/filter (decision 27); local-timezone day display (decision 27).
- **Done when**: a team-specific TTL prunes on its own schedule while others keep the global default; an expired raw payload is fetchable from the object store by key; the daily view for UTC+8 puts local midnight at local midnight.

### M3 — Delivery: compose and push

- **Scope**: Docker Compose (Server + Postgres + MinIO) and deployment doc (decision 26); org-level webhook push (decision 25).
- **Done when**: `compose up` on an intranet host serves the dashboard to a second machine; a finished session fires a webhook message; the offline buffer survives a Server restart from a client machine.

---

## Implementation notes (landed 2026-09-13, dev deployment)

Refinements settled while building, consistent with the decisions above:

- **Quarantine transport.** Quarantined lines ride the existing `POST /events` batch as a new `QuarantineEvent` (`kind: "quarantine"`, verbatim line byte-capped at 128 KB) and land in a `quarantine` table — never the event log. Inspectable at `GET /admin/quarantine`; the health page shows total/24h counters plus the latest verbatim lines.
- **Buffer overflow is reported as quarantine.** Queue-cap drops (corrupt lines, age, size) surface on the next successful send as a quarantine event with reason `buffer-overflow` and a `{dropped_events}` body, so loss is always visible on the health page.
- **The queue sweep only drains orphans.** E2E on the dev deployment caught the sweep replaying a live sidecar's queue file and tearing lines against its concurrent appends (visible as spurious `buffer-overflow` reports). The sweep now skips queue files whose sidecar is alive (pid + fresh heartbeat on ZCode, pid signal-0 on Claude Code); a live sidecar replays its own queue on every flush.
- **Roster endpoint.** `GET /teams` (any authenticated user) returns `{id, name, members[]}` from the _current_ org chart — the leaderboard's team column is a current-roster grouping of all-time totals, while per-session `team_id` keeps the ADR 0004 accounting snapshot for any future team-timeseries.
- **`user_hourly_rollup` added** (decision 27 groundwork): hourly turn/tool buckets fed at ingest alongside the daily table and recomputed from truth on delete/backfill; returned in `GET /rollups` as `user_hourly`. Local-day display re-buckets UTC hour rows in the browser.
- **Webhook shape.** One operator-configured URL (settings table, admin UI under a new settings tab) receiving `{text}` per finished session; `webhook_format` adapts the body to feishu/dingtalk dialects. `POST /admin/webhook/test` pushes a real delivery so setup errors surface immediately. Delivery is fire-and-forget off the ingest path.
- **SPA identity.** One user token (`localStorage`, legacy review-token key migrated) powers reads, review actions, and comments; the gate verifies via `GET /me` before rendering anything. The admin plane keeps its separate token and gained a settings tab.
- **Retention reads the session snapshot.** The prune job's effective TTL joins the ingesting session's `team_id` (the ADR 0004 snapshot) first — reassigning a member's team must not re-scope already-captured history — and falls back to the owner's current team only for legacy sessions that predate the snapshot.
- **Archive retrieval is an endpoint.** `GET /admin/archive?key=<archive_key>` (admin plane) returns an archived raw payload verbatim from the object store, closing M2's "fetchable by key" done-when without external tooling; only keys in the server's own `raw/<agent>/<session>/<seq>.json` namespace are accepted.
- **Local-day windows unclipped.** `GET /rollups`' hourly ceiling was raised from 7 days to 31 days of hours so the local-calendar-day charts (decision 27) can re-bucket a full month; the first cut silently zeroed days 8–31.
- **Partial S3 config fails at boot.** Setting some but not all of the `SLOPWATCH_S3_*` variables is a startup error, not a silent archiving-off (the fail-visible rule of decision 21 applied to the wiring itself).
- **The sessions filter follows the roster (2026-09-16).** `GET /sessions?team_id=` now resolves membership through `users.team_id` — the same current-org-chart semantics the leaderboard already uses (decision 27) — so the dashboard's rail filter and the leaderboard group people identically, and assigning a user files their existing sessions under the team. The per-session `team_id` snapshot keeps its ADR 0004 job: retention attribution only.
