# OIDC bearer tokens: the org IdP as a second token issuer

The first post-launch increment promised by v1 decision 6 and held over in
the v2 plan's out-of-scope list. Minted tokens stay exactly as they were;
when `SLOPWATCH_OIDC_ISSUER` and `SLOPWATCH_OIDC_AUDIENCE` are set, the
server additionally accepts RS256 JWTs issued by the org IdP: discovery
(`/.well-known/openid-configuration`) locates the JWKS, signatures are
verified against it (cached ~10 minutes, refreshed once on an unknown
`kid`), and `iss`, `aud`, `exp`/`nbf` are checked with a 60-second leeway.
Resolution order per request is unchanged for existing tokens — env tokens,
then minted tokens, then the IdP. The sidecar surface does not change at
all: the listener still sends `Authorization: Bearer <token>`; what changes
is who mints the token.

A verified identity maps onto the existing `users` rows: the `email` claim
first, then `preferred_username`/`sub`, and a first sighting provisions the
row so onboarding needs no admin-minting step. DRI and team assignment stay
admin decisions, so a provisioned user starts unassigned. A disabled user
stays locked out through either path, and a claim whose username lands on a
disabled or email-conflicting row resolves to nothing rather than merging
two identities into one account.

## Rejected

- **Switching wholesale to OIDC and dropping minted tokens.** The minted
  path is the bootstrap: OIDC is configured by an admin who authenticated
  with a minted token, and a broken IdP must not take a deployment's capture
  plane down with it.
- **HS256 / shared-secret tokens.** A shared verification secret on the
  server is exactly the "single shared org secret" v1 decision 6 rejected;
  asymmetric keys keep the server holding one fetched public JWKS.
- **Storing OIDC tokens in the `tokens` table.** They are verified
  cryptographically per request; table rows would fake a revocation story
  the IdP actually owns. Disable the _user_ instead — that gate is checked
  on every path.

## Consequence

A team can onboard without minting a single token: point the server at the
IdP, and a teammate's first request provisions their row. Existing
deployments change nothing until they set the two variables (all-or-none at
config parse, the same fail-visible rule the S3 block uses). The server
gains one outbound dependency — the IdP's discovery and JWKS endpoints,
fetched lazily and cached, so boot never blocks on the IdP being reachable;
an unreachable IdP degrades to plain 401s on IdP-issued credentials while
minted tokens keep working.
