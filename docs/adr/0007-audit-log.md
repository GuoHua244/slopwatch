# Audit log: an append-only trail of every data mutation

## Context

The admin and review planes mutate the Server's own data — users, teams,
tokens, settings, sessions, review markers, notes — and several of those
mutations are hard deletes. A deleted session, user, or note leaves nothing
behind: no record of who removed it, when, or what it was. For an internal
accountability tool the missing trail is a real gap: "who deleted that
session?" has no answer, and a revoked token or flipped role has no history.

## Decision

An `audit_log` table, append-only from the Server's perspective, records
**every successful human-initiated data mutation** plus the two automated
mutations that rewrite stored data. One entry per mutation:

- `actor` — `{kind: "user", user}` for a signed-in user, the `operator`
  pseudo-actor for the `SLOPWATCH_ADMIN_TOKEN` bypass (which carries no user
  identity), and `system` for the server itself (boot grants, prune sweeps).
  Actors are snapshotted as text with no FK, mirroring ADR 0004's philosophy:
  deleting a user must never erase or orphan their history.
- `action` — a `<resource>.<verb>` vocabulary: `user.create`, `user.update`,
  `user.delete`, `user.provision`, `team.*`, `token.mint`, `token.revoke`,
  `settings.update`, `session.delete`, `review.mark`, `review.unmark`,
  `note.add`, `note.delete`, `events.prune`.
- `target` — the affected thing, human-readable at action time (user or team
  name, session id, setting key). Renames are audited themselves, so the
  chain stays traceable.
- `detail` — structured JSONB. Updates carry a per-field `{before, after}`
  diff; hard deletes carry a snapshot of what vanished (a deleted session's
  agent, owner, title, event count and token totals; a retracted note's
  first 140 characters), so the trail outlives the data it describes.

**Scope.** Logged: all admin-plane mutations, the review-plane writes
(review markers, notes), first-sight user provisioning (`/me`, OIDC login,
`SLOPWATCH_ADMINS` boot grants), and raw-payload prune sweeps (one summary
entry per sweep). Not logged: `POST /events` telemetry ingest — the events
and sessions tables are themselves the record, and per-batch entries would
flood the log — and rejected requests (any 4xx): nothing mutated, nothing
to trace.

**Write semantics.** Entries are appended by the HTTP handlers after the
mutation succeeds, best-effort: a failed append logs to the console but
never fails the response — the change has already committed, and failing
would invite a retry of a non-idempotent operation. The one exception to
handler placement is OIDC provisioning, which happens inside auth resolution
and self-audits from the store. There is deliberately no update or delete
API for the audit log; `appendAudit` call sites are the only writers.

**Read plane.** `GET /admin/audit` — admin role or operator bypass only.
Newest first, filtered by action category prefix and actor substring,
paginated with a filtered total. The dashboard's admin area gains an
"Audit" tab: filter bar (category select, actor input), a table of
when/actor/action/target/change with color-coded action chips and a
one-line human summary rendered from the structured detail, click-to-expand
raw JSON, and a pager. No retention or TTL — administrative actions are
rare, and an audit trail that expires is not an audit trail.

## Rejected

- **Auditing inside each store mutation, in the mutation's transaction.**
  Would make the append atomic with the change, but requires threading the
  actor through every store method and reworking every transaction — and
  most audit context (who, from which route) only exists at the handler
  layer. Handler-level best-effort is the honest trade for this codebase.
- **A stored, pre-rendered summary string.** Derived text in the row
  denormalizes the record and freezes today's wording into history; the
  structured detail renders summaries client-side instead.
- **Logging failed attempts (403/404/409).** Nothing changed; the rejection
  is already visible in server logs. Revisit only if a security-audit
  requirement appears.
- **Members reading their own entries.** The log contains org-wide
  accountability data (deleted-content previews, other users' actions);
  admin-only is the safer default for an internal plane.

## Consequence

Every "who did this?" question about Slopwatch's own data now has an
answer in one admin tab. Hard deletes stop being information black holes:
the summary snapshot preserves the accountability-relevant shape of what
was removed. Costs: one extra read before each audited mutation (snapshot
or diff baseline — primary-key lookups), one insert after it, and the
caveat that a crash between mutation and append loses that one entry —
acceptable for an internal tool, and visible as a console error when it
happens. New mutating routes must wire `audit(...)` from day one; the
route-level tests in `audit.test.ts` fail closed by asserting the entry.
