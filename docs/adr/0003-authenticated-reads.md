# Reads require bearer tokens (the anonymous-read surface closes)

v1 shipped every read route and the dashboard anonymous — a deliberate trade for a single-operator box, with on-prem deployment as the whole security story. The v2 team rollout moves the Server onto a shared always-on intranet host, where anonymous reads mean any device on the network can enumerate sessions and read raw model I/O — colleagues' prompt and completion text — not just aggregate counts. From v2's M1, all reads (including the SPA) require a bearer token: the browser asks once for a user token, stores it in localStorage, and sends it on every request, the same mechanism the admin plane already uses. `/healthz` stays anonymous as an ops endpoint. Onboarding adds nothing: every team member already holds a token because their Listener needs one, and the later OIDC switch changes only the issuer, not this surface.

## Rejected

- **Keep anonymous reads behind the LAN trust boundary.** The LAN is not the org boundary — visitor Wi-Fi, printers, and anything that joins the network become readers of raw prompt text.
- **Anonymous aggregates, token-gated details.** Two auth tiers over one secret system to save each user one paste, when every token-holder is a legitimate full reader anyway.

## Consequence

A dashboard visitor must be an onboarded User; "open the URL and look" stops working for anyone without a token, which is the point. Rotation, revocation, and disable semantics are inherited from the existing token machinery unchanged.
