# Reads require bearer tokens (the anonymous-read surface closes)

v1 shipped every read route and the dashboard anonymous — a deliberate trade for a single-operator box, with on-prem deployment as the whole security story. The v2 team rollout moves the Server onto a shared always-on intranet host, where anonymous reads mean any device on the network can enumerate sessions and read raw model I/O — colleagues' prompt and completion text — not just aggregate counts. From v2's M1, all data-API reads require a bearer token: the browser asks once for a user token, stores it in localStorage, and sends it on every request, the same mechanism the admin plane already uses. The SPA itself ships as a static shell plus hashed assets served anonymously — the page loads for anyone, but with no token it has no data to render, since every read that could fill it is refused. `/healthz` stays anonymous as an ops endpoint. Onboarding adds nothing: every team member already holds a token because their Listener needs one, and the later OIDC switch changes only the issuer, not this surface.

_Amendment, at implementation: the bearer requirement scopes to the data API — the static SPA shell and its hashed assets are served anonymously; the SPA cannot display any data without a token._

## Rejected

- **Keep anonymous reads behind the LAN trust boundary.** The LAN is not the org boundary — visitor Wi-Fi, printers, and anything that joins the network become readers of raw prompt text.
- **Anonymous aggregates, token-gated details.** Two auth tiers over one secret system to save each user one paste, when every token-holder is a legitimate full reader anyway.

## Consequence

A dashboard visitor must be an onboarded User; "open the URL and look" stops working for anyone without a token, which is the point. Rotation, revocation, and disable semantics are inherited from the existing token machinery unchanged.
