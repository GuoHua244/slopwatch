# Password sign-in: the dashboard's human door, with the token as the first step

Until now the dashboard had exactly one door: paste a 51-character API token
(`sw_…`). That is the right credential for listeners and scripts — machines
hold secrets well — but a human being asked to paste an opaque token on every
fresh browser is being handed a machine problem. The token also couldn't be
"changed" without the admin minting a new one, and its only revocation story
was the admin plane. This decision gives every User a user name and password
for the dashboard while keeping tokens exactly what they were for tools.

## Decision

**Storage.** `users.password_hash` (argon2id, hashed with `Bun.password`;
`NULL` until the user sets one, so token and OIDC sign-ins keep working
untouched). Each password login mints one **Auth session**: a row in
`auth_sessions` (hashed bearer with the `swsess_` prefix, `created_at`,
`last_seen_at`, `revoked_at`, FK-cascaded on user delete). Sessions are
revoked — never deleted — so a reset is auditable and a stale bearer dies
immediately.

**The doors.** `POST /auth/login` takes `{name, password}` and returns a
session bearer that rides every later request like any other token — the
wire shape, the `Authorization: Bearer` header, and the client's localStorage
contract are all unchanged; the resolution order in `createAuth` simply grows
one probe (env tokens → minted tokens → auth sessions → OIDC). `POST
/auth/logout` revokes the bearer's session (a deliberate no-op for API
tokens: logging out never destroys an admin-minted credential). `PUT
/me/password` sets the password the first time without a current one and
requires it ever after; a change revokes every session except the caller's
own (a token bearer spares nothing, by hash non-match). The admin plane
gains `DELETE /admin/users/:name/password` — clear the hash and every
session, the reset for someone who lost both credentials, who then
re-initializes through the token door. `GET /me` and the admin users rows
carry `password_set`, so the UI knows which door to offer.

**The gate.** The sign-in page shows two doors: password sign-in first, and
a token door for first sign-in (the admin-issued secret) and recovery. A
token sign-in whose user has no password is invited — not forced — to set
one before entering; the prompt is skippable and the same affordance lives
on the profile page. Admin-minted tokens remain the tool/script credential.

**Abuse and oracle discipline.** Unknown user, wrong password, and disabled
user all answer one generic `invalid_credentials`, and the unknown-user path
spends the same argon2 verify work a wrong password costs, so response
timing names nobody. The one honest exception is `password_not_set`, which
deliberately names the fix (the token door) — an internal dashboard trades
that leak for not stranding first-time users. Failures throttle per name:
ten wrong passwords lock the name out for fifteen minutes, and every failure
pauses before answering.

## Rejected

- **Cookie sessions with CSRF protection.** It would fork the auth model:
  the whole server is bearer-token based, including programmatic listeners;
  one browser route would need its own credential transport, its own CSRF
  story, and a third way to be logged in. The session bearer keeps exactly
  one mechanism.
- **JWTs instead of session rows.** Stateless revocation is an illusion —
  "log out everywhere" and password-change-locks-browsers both need a
  denylist, which is a table. The session row is that table, plus it
  revokes instantly and leaves no signature-verification dependency.
- **Forcing a password at first sign-in.** Env-token and OIDC-provisioned
  users, and people who only ever use a token, must not be locked out of
  their own dashboard by a dialog they cannot skip meaningfully.
- **Email-based password reset.** There is no mail infrastructure and the
  operator already holds the admin plane; the admin reset plus the token
  door covers the lost-both-credentials case without a new channel.

## Consequence

Humans sign in with what they remember; tokens go back to their real job.
A password change locks other browsers out immediately, and the admin reset
is one call. Costs: one extra SQL probe per non-env bearer (the sessions
lookup after the tokens table misses), one nullable column on `users`, and
a lockout map that lives per-process — a restart clears it, which is the
honest scope for a single-process deployment. `auth.login` joins the audit
trail's vocabulary (`auth.password.set|change|clear` alongside it); token
verifications stay unaudited, as they always were. The `swsess_` prefix
keeps the three bearer shapes unambiguous on the wire so resolution order
can never mis-route a credential.
