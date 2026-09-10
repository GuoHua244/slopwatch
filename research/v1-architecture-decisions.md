# Slopwatch v1 Architecture Decisions

Partial notes from a design interview. Captures decisions reached so far and the questions still open. Pick up from the open questions list.

Companion to [`coding-agent-ingestion.md`](./coding-agent-ingestion.md) (capture-surface research) and [`../CONTEXT.md`](../CONTEXT.md) (glossary).

**Terminology note.** Earlier drafts of this document used "sidecar" / "slopwatch-capture" for the on-machine capture component and "backend" / "slopwatch-server" for the self-hosted process. The canonical names are now **Listener** and **Server** respectively (see `CONTEXT.md`). Older phrasings below are left intact for historical clarity; treat the glossary as authoritative.

---

## Resolved decisions

### 1. Deployment model: team/org, self-hosted, on-prem mandatory

One mode. No SaaS. No local-only fallback. Solo use is a degenerate "team of one" that falls out for free — not a separate product.

**Why.** Sessions are understood to be public within the org when a developer is plugged in. That trust/visibility model is team-shaped from day one. Building solo-first would mean redesigning identity, visibility, and the DRI review flow later, which is exactly the expensive part to change.

### 2. Visibility: org-wide by default

When a dev opts into Slopwatch, their sessions become visible across the org. Individual privacy is explicitly traded for org-level value. On-prem self-hosting is the mitigation — data never leaves the org's infrastructure.

### 3. DRI (Directly Responsible Individual) is first-class

Per-team role who reviews sessions. Not an afterthought bolted onto a generic user model. Review semantics (below) are deliberately left open.

### 4. Live-spectate: ~5s polling, not push

A manager or DRI can watch a running session. Originally scoped to ~100ms via fs-watch + LISTEN/NOTIFY; downgraded to **HTTP polling every ~5s, with `visibilitychange` triggering refresh on tab focus**.

**Why downgraded.** Polling eliminates pub/sub, SSE, and WebSocket infrastructure. Backend stays stateless HTTP. 5s is still "a human watching another human code" — the real-time budget is generous for this use case. Faster can be added later without schema changes.

### 5. Capture model: per-session sidecar spawned by hook; no always-on daemon

The on-machine capture component is **not** a pre-existing background daemon. It is a per-session subprocess whose lifecycle is driven by the agent's own hook/extension system.

- **Claude Code / Codex / Copilot / ZCode**: `SessionStart` hook launches `slopwatch-capture --session-id=... --agent=...` as a detached subprocess. That subprocess tails the agent's JSONL, receives subsequent hook fires on a local socket (named pipe on Windows), POSTs normalized events to the backend, exits on `SessionEnd`. (ZCode's hook catalog is now surveyed: it has `SessionStart` but **no `SessionEnd`**, so its sidecar's exit signal must come from elsewhere — e.g. the `Stop` hook plus an idle timeout; see the ingestion research. Its hooks also run inline, so the spawn must detach immediately.)
- **Pi / OpenCode**: in-process extension/plugin loaded into the agent itself. Posts directly to the backend. No subprocess at all.

**Why.** A pure "hook fires curl" model is insufficient — hooks don't carry full message content (Claude Code / Codex / Copilot) and nothing streams between hook fires while the model is generating. A pre-existing daemon solves that, but introduces a "dev forgot to start it" failure mode and a non-trivial install ceremony (launchd/systemd/Windows service). The per-session sidecar threads the needle: the hook _is_ the trigger that starts the process, so forgetting is impossible, and the process lives only during sessions — no always-on footprint.

**Consequence.** Concurrent sessions run concurrent subprocesses. They're cheap and independent. If coalescing becomes valuable (shared auth refresh, connection dedup), an optional always-on helper is a v2 addition that doesn't require changing the hook contract.

### 6. Auth: admin-minted per-user bearer tokens

OIDC is out of scope for v1. Instead:

1. Admin opens the self-hosted backend's admin UI, clicks "Add user," types a name + email.
2. Backend mints a long-lived bearer token. Admin hands it to the dev out-of-band (Slack, email).
3. Dev runs `slopwatch login <token>`. Sidecar stores it in the OS keychain (file fallback with 0600 perms on headless Linux).
4. Sidecar sends it as `Authorization: Bearer ...` on every request.

**Why.** OIDC device flow against an org IdP is the "right" answer but expensive to build for v1. Admin-minted tokens give trustworthy identity (each token bound to a user record), clean revocation, and a clean upgrade path: OIDC later becomes "another issuer of the same kind of token." The sidecar's auth surface stays a bearer token the whole time.

**Rejected.** A single shared org secret + git-config-email as claimed identity. Lighter to build but poisons the data — "whose session is this really?" is the exact question the product exists to answer, so the identity claim can't be spoofable during the validation period.

### 7. Deployment topology: single-binary app + externally-operated Postgres

One Go/Rust binary containing backend HTTP server + embedded frontend static assets. Points at a Postgres URL via flag/env var. Postgres is **not** embedded, not SQLite, not optional — it's a separate deployable unit the admin operates.

**Why separate.** The database must outlive app-version changes, be backed up independently, and be reasoned about as its own asset. Embedded SQLite would couple those lifecycles.

**What the admin does.** Provisions a Postgres instance (existing one, RDS, self-hosted, whatever they already know how to run). Runs `./slopwatch-server --db=postgres://...`. That's it.

**Rejected.** Docker Compose as the default shape (too opinionated about where Postgres comes from). K8s manifests as the only option (excludes smaller orgs). SQLite-default hybrid (violates the "separate deployable" constraint).

### 9. Session data model: DAG of turns inside one session

A **Session** is the logical run of one coding agent for one developer in one cwd. It contains a **directed acyclic graph of Turns** — linear for Claude Code / Codex / Copilot / OpenCode, a real tree for Pi.

- **Branches** (Pi) are nodes in the DAG, not separate Sessions. The data model stores `parent_turn_id` on each Turn. "The active leaf" is what live-spectate follows.
- **Subagents** (e.g. Claude Code Task tool) are **child Sessions** with `parent_session_id` + `spawned_by_turn_id`. Reviewed and queried independently.
- **Two units inside a Session**: a **Turn** is one user message + the full assistant response including all tool-use loops. A **Model request** is one HTTP call to the provider during a Turn; many Model requests per Turn. The cost dashboard sums Model requests; the DRI reviews Turns.
- **Resumes** (Codex `codex resume`, Pi resume, Claude Code compaction-continue) are **deliberately unresolved** until v1 is running — the right shape is hard to see in the abstract, and deferring costs nothing because each of the five agents treats resume differently anyway. Revisit with real data.

**Why DAG-inside-session instead of branch-as-separate-session.** Modeling every Pi branch as its own Session inflates session counts ("Alice ran 6 sessions today" when she meant "I explored 6 alternatives in one session"), breaks live-spectate URLs at every branch point, and forces review UIs to re-aggregate across rows. Keeping the DAG internal means the non-branching agents see a degenerate linear DAG (free), while Pi gets honest tree structure without polluting the top-level schema.

**Rejected.** Flattening subagents into the parent Session's Turns. Loses the "how is my Explore subagent behaving this week" query, which is exactly the kind of thing a DRI wants to ask.

### 8. Live-spectate implementation: stateless polling over Postgres

- Sidecar POSTs events to backend; backend writes to Postgres with a per-session monotonic `event_seq`.
- Watching browser calls `GET /sessions/:id/events?since_seq=N` every ~5s and on tab-focus.
- Backend is stateless — any replica can serve any query.

**Why.** Matches the single-binary + Postgres constraint. No LISTEN/NOTIFY, no pub/sub, no in-memory watcher tables. Horizontal scaling later comes free.

---

## Resolved 2026-09-09 (pre-implementation design review)

### 10. Review model: DRI is a queryer, not a recipient

The inbox starts empty. A DRI pulls from a filterable firehose (cost threshold, repo, user, unreviewed-first) and marks sessions reviewed. Accepted shape carried over from the earlier proposal: review state lives on an entity separate from session lifecycle, the review unit is turn-level comments (`review_comments(session_id, turn_seq, author_id, body, created_at)` plus `session_reviews(session_id, reviewer_id, reviewed_at)`), and notifications stay pull-only in v1.

- **Scoping in v1 is org-wide** — no `Team` entity yet; filters group by the session's dimension fields (repo, machine, user).
- **DRI is a role attribute of a User**, not a separate identity; one person can be DRI and a reviewed developer at the same time.
- **The only DRI-exclusive power is the accountability marker** ("mark reviewed"). Viewing and commenting are org-wide powers, following from decision 2.
- **Why not recipient**: routing rules plus an assignment state machine contradict the org-visibility philosophy and the minimal-infra thread (decisions 4 and 7). Pull → push is additive later; the reverse is not.

### 11. Data retention: two global defaults, raw expires

Normalized events and review records are kept forever. Raw agent payloads (stored as JSONB — see open question 2) expire on a 90-day default TTL, enforced by a daily prune job inside the Server, configurable via environment variable only — no UI. Per-team policies and cold-archive-to-S3 are v2. This also caps the growth risk of JSONB-first raw storage.

### 12. Frontend: React SPA (Vite), statically embedded

The v1 dashboard is a React SPA built with Vite; its output is embedded into the single binary as static assets, so the single-binary + stateless shape holds (decision 7). The leaderboard prototype was already React — prior art exists. The tracer bullet ships a hand-written polling page first; the API is identical, so the swap is free. Server-side frameworks (Next/Remix) are rejected: they require a running server process.

### 13. Admin UI: minimal set plus session deletion

Users (add/disable/delete), token mint/revoke, and a system-health page — plus a per-session delete/anonymize action. In an org-visible product, "someone pasted a secret into a prompt" is an inevitable incident and visibility amplifies its radius; the remediation tool ships with the visibility. "Pause reporting" is not built separately — disabling a user kills its token immediately. Retention-policy and team-configuration UIs are v2.

### 14. Identity beyond the token: environment facts only

Session events carry `hostname`, `cwd`, and `git remote URL` — dimension fields for DRI filters and the leaderboard ("cost per repo"). Explicitly not carried: git email and OS username — anything that reads as an identity claim. The bearer token is the only identity (decision 6's reasoning, applied).

---

## Resolved 2026-09-10

### 16. Install flow: one command, central credentials, user-scope hooks

`slopwatch install` (packages/cli, the `slopwatch` npm bin) detects installed agent hosts by home-directory presence — no `--version` process spawns (slow, antivirus-patrolled on Windows) — verifies the admin-minted token against `GET /me`, and stores it in `~/.slopwatch/config.json` (0600) together with the server URL and the optional llm summary block (the dependency open question 15's design placed here). **Hook commands carry no credentials**: hooks and sidecars resolve server-url/token as argv-pair-override → central config → stdout mode, so the token never sits in per-project config files and rotation is one `login` away, not a re-install per project.

- **Commands**: `install` (detect + verify + wire), `login <token>` (verify + store; decision 6's step 3), `status` (detection, wiring, redacted config), `uninstall` (strips only our entries; deleting the config file is an explicit separate act). A rejected token writes nothing — fail loudly at install time, not silently at capture time.
- **Token distribution stays decision 6's shape**: the admin mints in the admin UI, hands the token out-of-band, the developer runs `login`/`install` on their machine.
- **Wiring reuses the listeners' idempotent merge functions** (CLI imports them via package exports); the CLI side adds `removeHookConfig` for uninstall. The zcode listener defaults to **user scope** (`~/.zcode/cli/config.json`): user-level hooks fire in every project and skip the workspace trust gate — live confirmation still pending (below); `--dir` opts into project scope with its trust-prompt caveat. The claude-code listener keeps user-scope `~/.claude/settings.json`. Credential-free entries idempotently replace the legacy embedded-token ones on upgrade.
- **LLM summary config** (`--summary-endpoint/--summary-model/--summary-key`, OpenAI-compatible, endpoint may point at an internal gateway) lands in the same file; an absent block means summaries stay silently off (open question 15's design).
- **npm distribution is a non-goal while the repo is private**: installed hooks reference the repo checkout's listener scripts, so re-running install after moving the checkout refreshes them. `npx slopwatch` polish (bundled scripts, publish) comes with public packaging.
- **Spike (pending)**: wire user-scope zcode hooks, restart the client, start a session outside a wired workspace, confirm the Server saw it and no trust prompt appeared. If user-scope hooks turn out to be gated too, fall back to workspace scope as the default.

### 17. Session summaries: client-side rolling fold at every end

Open question 15's direction confirmed and shipped. Each listener keeps a rolling summary cache (`<state-base>.summary.json`: last body, model, folded count) plus a JSONL log of not-yet-folded turn digests beside its cursor; one digest line accumulates per turn (user words, model-request count, token totals, tools). At every session end the listener folds the new lines into the previous summary with a single OpenAI-compatible chat call to the developer's configured endpoint and ships the result as a `session`/`summary` event (body + model) immediately before `session:end` in the same batch.

- **Ends with no new turns skip the LLM entirely.** A missing summary block, an unreachable endpoint, or a failed/timed-out call never blocks capture — the digests stay pending and the next end retries them; the end event always goes out.
- **The endpoint is the developer's own** (install flow's summary block, decision 16) so no new data-egress boundary appears; the provider can be an internal gateway.
- **Turn ordinals stay cumulative across sidecar generations** (folded count + pending log length), so the LLM sees a stable history even though the process restarts at every idle timeout.
- **The dashboard renders the latest summary as a banner** on the session page, labeled machine-generated with the producing model: a reading aid, never evidence — the event stream remains the record.

---

## Open questions — pick up here

Roughly in priority order for continuing the design. Resolved since: 1/3/7/11/13 (2026-09-09 decisions), 8/9 (ADR 0001), 5 (resolved for v0 by the M1 code — see the note there), 10 (2026-09-10 — decision 16), and 15 (2026-09-10 — decision 17). Still open: 2, 6, 12 (deferred 2026-09-10 — see the note there), plus the buffering half of 4 (numbered past 14 to avoid colliding with decision 14):

1. **DRI shape** (blocks the review schema). Four edges surfaced mid-grill but unresolved:
   - **Queryer vs recipient**: DRI pulls from a filterable firehose, or sessions get auto-routed to a DRI's inbox on end?
   - **Scoping**: DRI per team (requires a `Team` entity) or per org?
   - **Attribute vs identity**: can one user be DRI for multiple teams and a reviewed dev on the same team?
   - **Permission boundary vs accountability marker**: given org-wide visibility, is the only DRI-specific power "mark session as reviewed," or do DRIs also gate who can view/comment/spectate?
   - **RESOLVED 2026-09-09** — queryer · org-wide in v1 · role attribute · mark-reviewed is the only DRI-exclusive power. See decision 10.
2. **Raw agent-specific payload storage.** NormalEvent keeps the original raw event for fidelity. Store as JSONB alongside normalized events in Postgres, or offload to an S3-compatible blob store with a pointer in Postgres? Depends on expected payload sizes and how often raw is actually read. Direction set with decision 11: start with JSONB; revisit with real payload-size data.
3. **Data retention and pruning.** Keep everything forever? TTL-based deletion? Per-team retention policy? Archival to cold storage? **RESOLVED 2026-09-09 — decision 11.**
4. **Sidecar buffering when backend is unreachable.** Local append-only log on disk? How much? What happens when it fills? v0 behavior: drop events while unreachable; design buffering with real failure data.
5. **NormalEvent schema specifics.** The research enumerates the categories (Session, Turn, Message, Tool event, Model request, raw payload) but the exact fields, especially for tricky cases (Pi's DAG, Codex resumes, Claude Code compaction, subagent transcripts), are not drawn. **RESOLVED for v0 2026-09-09 — NormalEvent v0 (`packages/events`) shipped with the M1 code and tests and is the de-facto standard.** Two binding constraints: `agent` is an open string, never a closed enum; and fields are organized by glossary category — a discriminated union of session start/end/meta, turn start/end, model_request, and tool call/result — with `schema_version` plus a `raw` escape hatch, mirroring no single agent's naming. There is no separate Message kind; the user message is a field on turn start. Pi's DAG (`parent_turn_id`) and subagent sessions (`parent_session_id`/`spawned_by_turn_id`) have fields; Codex resumes and Claude Code compaction get theirs when those listeners need them.
6. **Schema-drift handling per agent.** Claude Code JSONL is undocumented; Copilot JSONL is undocumented; Pi has bumped schema v1→v2→v3. Adapters need a version detection + pin strategy. What does "adapter doesn't recognize this version" do — fail closed, fail open with warning, partial capture?
7. **Frontend stack.** Bundled into the binary as static assets — but React SPA? Server-rendered? HTMX? Affects dev velocity and the "single binary" build pipeline. **RESOLVED 2026-09-09 — decision 12.**
8. **Backend language/runtime.** Go, Rust, Node? Affects sidecar consistency (same language across sidecar + backend?) and the in-process TypeScript extensions for Pi/OpenCode (those _must_ be JS/TS). _(Resolved by ADR 0001 — Bun/TS everywhere.)_
9. **Sidecar language.** Must run on dev machines across macOS/Linux/Windows with minimal install friction. Node (available wherever the agents are installed)? Go (single static binary per OS)? Rust (same)? _(Resolved by ADR 0001 — Bun/TS everywhere.)_
10. **`npx slopwatch install` flow.** Detect installed agents, wire up per-agent hooks/extensions idempotently, store backend URL + token. Exact UX not drawn.
    - **RESOLVED 2026-09-10 — decision 16.** Detection by home directory; central credential store the hooks read at fire time; user-scope hooks by default; the CLI reuses the listeners' merge functions instead of reimplementing them.
11. **Identity binding beyond the token.** Does the sidecar send extra context (git email, OS user, hostname, cwd, repo)? Which of those are useful for the DRI view vs. noise? **RESOLVED 2026-09-09 — decision 14.**
12. **Cost/token tracking.** Codex and Claude Code emit token usage; Copilot JSONL probably does too. Normalizing across providers (OpenAI vs Anthropic pricing, cached tokens, reasoning tokens) is its own small project. **DEFERRED 2026-09-10 — product decision: not scheduled for now.** Token totals are already captured and stored per session (`sessions.total_*_tokens`); only cross-provider price normalization is missing.
13. **Admin UI scope.** Minimally: add/revoke users, view system health, configure retention. What else needs to be in v1? **RESOLVED 2026-09-09 — decision 13.**

_(Numbering skips 14 (taken by decision 14) and 15 (taken by open question 15).)_

15. **LLM session summaries (raised 2026-09-10).** A machine-generated "what happened in this session / did it finish" summary shown on the session page, to make review scalable — a DRI reads summaries first and drills into turns only when one smells. Two placements considered: a server-side batch job summarizing at session end with a management LLM key, or the sidecar summarizing locally right before it emits session end. **Direction (2026-09-10, pending final call): client-side preferred.** The sidecar is the authority on when a session truly ended (Stop + idle timeout; the Server cannot tell an end from a pre-resume end), the developer's own provider key means no new data-egress boundary (the agent already sends this conversation to the same provider — a management key on the Server would widen it), cost attribution stays per-developer, and the Server stays a stateless store with no job scheduler. Cost of this choice: the sidecar needs a key (natural home: the install flow, open question 10 — wire the two together), listeners without a configured key skip summaries silently (capture is never blocked), each listener implements the same summarize-and-report step (shared package), and summaries come from the observed machine — so they are a reading aid, never evidence; the raw events remain the record. Schema impact is one new NormalEvent kind (`session`/`summary`: body + model), backward compatible.

- **Summaries must roll incrementally, not re-run per end (2026-09-10).** A rollout session accumulates many start/end cycles (every idle-timeout ends the sidecar; resuming re-attaches with a fresh start), so "summarize at end" must never mean "re-read the whole transcript at every end". Design: the sidecar keeps a summary cache next to its cursor (last summary text + how far it has folded in); at each end it folds in only the turns added since — old summary plus a small digest of new turns — and skips the LLM entirely when nothing new arrived. Every meaningful end leaves the summary current and the last one wins, which also removes the need to identify "the real end". Cost per update is ~1-3k tokens against sessions that burn millions per day — noise.
- **RESOLVED 2026-09-10 — decision 17.** Client-side confirmed; shipped as `packages/summary` plus the `session`/`summary` event, wired into both listeners' end paths and rendered on the session page as a labeled reading aid.

---

## Architectural shape, as of this document

```
┌───────────────────────────────┐        ┌───────────────────────────┐
│ Developer machine             │        │ Org-operated self-hosted  │
│                               │        │                           │
│  Coding agent (Claude Code,   │        │  slopwatch-server         │
│  Codex, Pi, OpenCode, Copilot)│        │  (single binary)          │
│   │                           │        │   - HTTP API              │
│   │ hook fires / plugin loads │        │   - Static frontend       │
│   ▼                           │        │   - Stateless             │
│  slopwatch-capture            │──POST─▶│                           │
│  (per-session subprocess,     │ events │          │                │
│   or in-process extension     │        │          ▼                │
│   for Pi/OpenCode)            │◀polls──│  Postgres (separate       │
│                               │        │  deployable, org-operated)│
└───────────────────────────────┘        └───────────────────────────┘

                              ▲
                              │ polling GET /sessions/:id/events?since_seq=N
                              │
                   ┌──────────┴──────────┐
                   │ Browser tab         │
                   │ (DRI / manager /    │
                   │  dev themselves)    │
                   └─────────────────────┘
```
