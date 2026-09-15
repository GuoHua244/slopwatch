# Role-based authorization: the admin plane and read scope follow `users.role`

The first post-launch follow-up to decisions 13 and 22. Until now the admin
plane was guarded by one static shared secret (`SLOPWATCH_ADMIN_TOKEN`) and
every authenticated read was org-wide: anyone holding any valid user token
could browse every session, and anyone holding the operator token — a single
secret shared by every operator, pasted into each browser — had full admin
powers. This decision replaces both properties with a per-user role.

## Decision

`users` gains a `role` column (`admin` | `member`, defaulting to `member`;
new `users.role` column via the idempotent DDL). The role drives two things,
checked server-side on every request:

1. **The admin plane.** `GET/POST/PATCH/DELETE /admin/*` passes for a
   signed-in user whose role is `admin`. `SLOPWATCH_ADMIN_TOKEN` survives as
   an operator _bypass_ — a bearer equal to it still authorizes everything,
   which is how the first admin is bootstrapped and how break-glass access
   works when every admin account is broken. An empty admin-plane env no
   longer disables the plane; it only removes the bypass. A signed-in member
   gets 403 (not 401 — authenticated, unauthorized), and the dashboard no
   longer asks for a second token: the admin route renders for whoever's
   `/me` says `role: "admin"`.
2. **Read scope.** Admins keep the org-wide read plane (all sessions, all
   rollups, any session's events). Members are scoped to themselves:
   `/sessions` returns only their own sessions, `/rollups` only their own
   rows, and `/sessions/:id/events` answers 404 for a session they do not
   own — 404, not 403, so the existence of other people's sessions never
   leaks through probing.

Bootstrap: `SLOPWATCH_ADMINS` (comma-separated names) grants the admin role
idempotently at boot (`ensureAdmin` — insert or promote, and un-disable).
First sight through `GET /me` also provisions a `users` row for env-token
users, so the operator can promote anyone from the admin users panel without
manual SQL. An admin cannot change their own role from the admin plane
(self-demote could strand the plane with no admin); another admin or the
operator bypass does it.

The dashboard follows the same shape: leaderboard and admin nav links render
only for admins, those routes render a "not authorized" notice for members,
and the profile (`me`) route carries identity, role, team, DRI flag, the
user's own lifetime usage, and sign-out.

## Rejected

- **Roles as a separate table (users × roles join).** One deployment, two
  roles, assignment is an operator act — a boolean-like column is the whole
  model; a join table would add motion without a third role to justify it.
  If a third role ever appears, this column migrates forward cleanly.
- **Keeping the admin-token gate in the UI alongside role sign-in.** Two
  parallel sign-ins for one plane trained operators to paste secrets into
  browsers; the bypass stays a server-side escape hatch, not a second door.
- **403 for foreign sessions on the events endpoint.** A 403 confirms the
  session exists; 404 leaves the probe with nothing.

## Consequence

Authorization is per-person and revocable per-person: demote an admin and
their browser loses the plane on the next request, with no shared secret to
rotate. The operator token stops being a per-browser credential — it can
now live in a vault and appear only in break-glass hands. Cost: `roleOf`
adds one primary-key lookup per authenticated read, and every operator must
grant the first admin (one env var at boot, or one PATCH through the
bypass). A member-facing view of someone else's session through any future
endpoint must re-apply the same owner-or-admin check — the store's
`sessionOwner` is the primitive to reach for.
