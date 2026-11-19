# Slopwatch v3 Plan — Observability Depth

**Status: IN PROGRESS (2026-11-20).** Seven features adopted from the feature survey, ordered by dependency: the waste metrics feed the leaderboard, the alerts, and the weekly report; the MCP server lands last so it can expose everything else. Decision numbering continues the ledger: 1–19 in [`v1-architecture-decisions.md`](./v1-architecture-decisions.md), 20–30 in [`v2-plan.md`](./v2-plan.md). The "quick wins" from the survey (retro prompt i18n, npm packaging, Codex listener v1 leftovers) stay out of scope here.

Goal: deepen what the captured stream can answer. v1/v2 answered "who spent what when"; v3 answers "how well was the work done" (waste metrics, waterfall, model comparison, commit correlation), "when should someone look" (alerts), and "what happened this week" (weekly report) — plus a machine-readable read surface (MCP) so agents can ask the same questions.

- [x] 31. Waste metrics — deterministic slop counters on the ingest path, surfaced as a leaderboard column
- [x] 32. Session token waterfall — per-turn token burn chart in SessionDetail
- [ ] 33. Anomaly alerts — threshold checks pushed over the org webhook
- [ ] 34. Session ↔ commit correlation — git commits extracted from tool calls
- [ ] 35. Model comparison view — two-model observational comparison
- [ ] 36. Team weekly report — LLM weekly retrospective over team rollups
- [ ] 37. Read-only MCP server — token-gated tools over the org's own data

---

## Decisions

### 31. Waste metrics: failed tool calls and repeated identical calls, counted at ingest and rebuilt from truth

The name says slopwatch but nothing in the code judged sloppiness — the closest was a retrospective prose angle. v1 decision 12's LLM retros stay the qualitative plane; this adds the quantitative one, deliberately **deterministic and agent-agnostic** (no per-agent tool-name tables, no content heuristics): two counters computed from the event contract alone.

- **`failed_tool_calls`** — tool result events with `ok: false`. Universal: every listener normalizes results with an ok flag.
- **`repeated_calls`** — occurrences beyond the first of an identical (session, tool, args) tool call. JSONB equality is the exactness trick: `payload->'args'` compares as a value, so "identical call" needs no normalization table and no hash collision reasoning. Legitimate repeats exist (re-grepping after a fix); the counter is an honest redundancy rate, not a verdict.
- **Waste rate** = (failed + repeated) / tool calls, rendered as a leaderboard column. All-time grain, matching how the leaderboard's Turns column already reads the totals rows.

**Storage.** `sessions` and both flat rollup tables (`user_daily_rollup`, `user_hourly_rollup`) gain the two columns. The ingest transaction computes both per session — failures are batch-local; repeats need one prior-occurrence `COUNT` per distinct (tool, args) pair in the batch, correct under the session-row lock that already serializes writers. Rollup attribution buckets each repeat to its own occurrence's day/hour.

**Recompute parity is the invariant.** `recomputeRollups` (backfill, post-delete) and a session-grain waste rebuild derive both counters from the events table with a `ROW_NUMBER` over (session, tool, args) ordered by (occurred_at, event_seq) — occurrence `rn > 1` is exactly what the incremental path counts. The test asserts incremental ingest == recompute output, so the "aggregates can never drift from the events" property (decision 18) carries to the new counters.

**Rejected.** Per-agent tool-name parsing to detect edit→revert thrash — a permanently maintained adapter asset the event contract does not carry (same reasoning that deferred cross-provider price tables, v1 open question 12); content-similarity heuristics — nondeterministic, unexplainable to the developer being measured; an LLM "slop score" — that is the retrospective's job, with evidence and prose.

### 32. Session token waterfall: where the tokens went, per turn

CONTEXT.md's founding dialogue — "this session cost $14 — where did it go?" — is currently answered by scrolling turns. SessionDetail gains a horizontal per-turn bar strip: one bar per turn, width proportional to that turn's total tokens, stacked into the four canonical token kinds (input / output / cache read / cache write — the same sums the Usage panel and the rollups carry), labeled on hover with the turn's user message and the numbers. An "(unattributed)" bar covers requests the timeline could not file under a turn, so the strip's total reconciles with the session's own totals. Data comes entirely from the events the dashboard already polls — no new endpoint, no new table, no recompute. Scope note: the waterfall covers **this session's own stream** — subagent sessions are separate Sessions (v1 decision 9) with their own event streams and their own waterfall on their own detail page; folding child burn into the parent would need a cross-session aggregate endpoint, deferred until someone misses it. Rejected: a time-axis flame graph — turn durations are wall-clock, not token burn, and would misrepresent cache-heavy turns.

### 33. Anomaly alerts: thresholds over the org webhook

The org webhook (v2 decision 25) pushes nothing on its own today. The server grows a threshold checker evaluated on the ingest path: (a) a session's total tokens cross the configured ceiling with zero tool calls at all — pure-chat burn; (b) a user's hourly token total crosses a spike ceiling (an absolute, configured number — no baseline statistics to explain or debug). Findings land in the audit log and fire the existing webhook fire-and-forget; admin-configurable through the settings plane, defaulting to off. Rejected: per-user notification channels (v2 deferral stands); baseline anomaly statistics — a threshold a human can recompute beats a moving average nobody can.

### 34. Session ↔ commit correlation: what the agent shipped

Tool-call `args` already carry what the agent ran. A server-side extractor watches tool **call** events for `git commit`-shaped commands (`git commit …`, `git push …`, plus hub-CLI PR creation), lifts the resulting sha (from the command's output via the paired result when present, else the command line's own `-m` context is not enough — v1 keeps it to the sha/short-sha visible in args or result text), and stores one row per (session, sha) in a `session_commits` table. SessionDetail lists linked commits; the extractor is generic string matching over the two universal event fields, so every listener benefits without adapter changes. Rejected: running git in the working tree server-side — the server has no clone and no right to one; diff stat extraction — needs a repo, same rejection.

### 35. Model comparison view: two models, same org's real workloads

Not a benchmark — an observational comparison over the model-grain rollups the server already stores. A view picks two models and a window and shows them side by side: requests, tokens (in/out/cache), sessions and turns touched, tokens-per-request, and — once 31 ships — waste rate, so "which model burns less" gets an evidence column. Same-window filtering makes the comparison honest about workload mix rather than pretending at A/B pairing. Rejected: synthesized paired runs (the product observes; it does not experiment), price normalization (deferred, v1 open question 12).

### 36. Team weekly report: the retrospective at team grain

The per-user retrospective (ADR 0008) grows a team-week preset: rollup deltas week-over-week, top spenders and their biggest sessions, waste-rate movement (decision 31), and linked commits as the week's shipped work (decision 34). Runs on the requesting admin/DRI's own LLM credentials through the existing fold/queue machinery (ADR 0010's caller-pays rule carries), rendered as a stored markdown report with the same snapshot discipline as session retros. Rejected: scheduled auto-runs — cron-triggered LLM calls on shared credentials was the exact shape ADR 0010 rejected; the report is a pull, generated when someone asks.

### 37. Read-only MCP server: the org's data, answerable by agents

The server exposes an MCP endpoint (streamable HTTP, bearer-token auth — the same token every member already holds) with read-only tools: session lookup, recent sessions, per-user usage, leaderboard, session events page. Tools map one-to-one onto the existing read-plane queries and inherit their scoping (members read only their own rows; admins read org-wide). No write tools, no resource subscriptions, no server-initiated pushes — observability reads only, so the token's authority never widens beyond what the dashboard already grants. Rejected: a separate MCP service — a second process to deploy for a route handler's worth of code; write tools (retrospective trigger, session delete) — v1 keeps an agent from mutating the record of agents.
