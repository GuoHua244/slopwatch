# Dashboard SPA implementation choices

Follow-up to ADR 0001 (Bun everywhere) and decision 12 in
`research/v1-architecture-decisions.md` (React SPA via Vite, statically
embedded). Decision 12 fixed the stack; this record fixes the
implementation choices the stack leaves open, which the first four
dashboard milestones (F1 skeleton, F2 event stream + turn view, F3
usage aggregation, F4 leaderboard) committed to.

## Decisions

### Routing: hand-rolled hash router, no router dependency

The dashboard has two views (`#/sessions`, `#/leaderboard`); a ~15-line
`hashchange` hook covers them. A router library buys nothing at this
size and would be the largest runtime dependency after React itself.
History routing is unnecessary for a dashboard and would need server
fallback config once embedded; hashes work identically in dev, in the
embedded binary, and under file inspection.

### State and data flow: hooks + a testable poller engine, no data library

All remote state lives in three hooks (`useSessions`, `useEventStream`,
`useSessionCosts`) built on one `createPoller` engine that implements
decision 4's contract exactly: tick every ~5s while the tab is visible,
tick once on `visibilitychange` to visible, never overlap ticks, keep
the loop alive across tick errors, and skip all ticks while hidden.
The engine takes injectable timers/visibility so the semantics are unit
tested without a DOM; React stays a thin wrapper. react-query et al.
were rejected: the polling contract is small, fixed, and worth owning.

### Styling: plain CSS with custom properties, dark monospace language

Single `styles.css`, the bare tracer-bullet page's palette and
monospace type carried over (it is the product's visual language, and
the bare page is its prior art). No CSS framework: the surface is a
handful of data tables and lists, and framework resets fight
`font-variant-numeric: tabular-nums`-style data-table typography more
than they help.

### The event table is the ground truth for aggregates

The Server's `sessions` token columns only cover events appended after
that migration shipped, so sessions that predate it undercount (a
dogfooded session reports 17.0M input on the session row while its
events sum to ~78M). Everywhere numbers must add up — the session
detail token line, the usage table, the leaderboard — sums come from
the events themselves; the session-row columns are only the
loading-state fallback. If the Server later backfills its columns,
this rule can be revisited.

### Tool-to-turn attribution is positional, not declared

Tool events carry no `turn_id` (schema v1), so the timeline files a
tool call under the turn of the latest preceding `turn:start` or
attributed model request. Exact for the linear turn DAGs of the current
listeners; approximate for branching sessions (Pi), accepted until a
real branching capture exists to design against. Turns never announced
by a `turn:start` are synthesized from `turn_id` sightings, because the
dogfooded listener emits no turn events yet.

### Cost: an editable in-app pricing table, estimates only

Prices live in `src/lib/pricing.ts` (USD per million tokens, seeded
from public list prices checked 2026-09-09); subscription billing makes
them estimates, and the UI labels the column "cost est." Matching is
exact model name first, then family prefix in table order. Unknown
models render as an em dash; a total only shows a cost when every
contributing request is priced; zero-request sessions contribute zero
spend, not an unknown. Cache-write and reasoning tokens are unpriced
because the surveyed public prices do not list them.

### Per-session stats fetching: roster-scale N+1, accepted

The leaderboard needs every session's events, fetched incrementally
when a session's `last_seq` moves. This is an N+1 that is fine at the
product's stated scale ("a team / org roster") and wrong past it; the
`user_daily_rollup` / `user_hourly_rollup` backend tables implied by
`research/developer-leaderboard-design.md` remain the real answer and
stay open on the backend. The leaderboard prototype's hourly
sparkline, team/avatar identity, and 7-day delta columns are likewise
deferred until those rollups exist.

## Consequence

`apps/web` builds standalone today (`bun run dev` proxies the API to
the locally running Server; `bun run build` emits `dist/`). Embedding
into the single binary (decision 7) is a later, mechanical step: serve
`dist/` from the Server with a same-origin catch-all and drop the bare
page.
