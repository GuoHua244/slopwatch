# Summary folds execute on the server, on the caller's own LLM credentials

The rolling session **Summary** was the one LLM feature keyed from the
observed machine: `slopwatch install` wrote an optional `summary` block
(endpoint, model, API key) into `~/.slopwatch/config.json`, and the listener
called the provider directly at each session end. That spread a plaintext
provider key across every machine being observed, duplicated credentials the
product already manages per user (ADR 0008's profile LLM config), and gave
key rotation no single place to happen. The trigger for the change was
billing: the per-user key moved onto a GLM Coding Plan subscription whose
quota is only consumed through the plan's dedicated endpoint, so the
endpoint is now part of the credential — exactly the thing the profile page
already stores and per-machine config would have to mirror everywhere.

## Decision

1. **One executor.** `POST /summary/fold` ships the fold prompt to the
   Server; the Server executes it with the caller's own profile
   credentials (`users.llm_*`) — the same config **Retrospectives** run on.
   `GET /summary/llm` reports whether credentials exist, nothing more.
2. **No credentials, no summary.** A user without profile credentials gets
   no fold at all: the listener checks before folding and stays silent,
   the same observable behavior as an install before the feature existed.
   Digests stay pending on disk for whenever credentials appear.
3. **ADR 0008's write-only rule holds.** No read returns the API key, and
   the listener never sees it — a client-side fold would have required
   breaking that invariant.
4. **Timing parity with the old client-side call.** The per-attempt LLM
   timeout (60s) and the ×4 budget-raising retry for reasoning blowouts
   live in the server's `chatCompletionDetailed`; the listener's round
   trip allows 150s to cover both attempts plus the hop.
5. **Local config removal.** The config file's `summary` block and the
   install `--summary-endpoint/--summary-model/--summary-key` flags are
   deleted. Unknown keys in existing config files are ignored rather than
   rejected, so old files keep loading; the leftover block is inert.

## Rejected

- **Returning the profile key to the listener** so it could call the
  provider directly: breaks ADR 0008's never-returned-in-full guarantee,
  puts the key in process memory on every observed machine, and lags
  profile edits until the next config refetch.
- **Keeping the local `summary` block as a fallback**: two credential
  sources for one call means two places billing semantics can silently
  diverge — the bug class this change exists to remove.

## Consequence

The Server is now in the summary LLM path, but that adds no new
availability dependency: folds already probed `/healthz` before spending
tokens, and the probe's original waste case — a fold computed offline and
lost with the failed POST, then re-burned on the next end — can no longer
happen, since a fold can only run when the server can take it. Folds are
automated per-session-end events, not user-initiated mutations, so they
write no audit trail. Listeners and servers from before this change
interoperate gracefully in both directions: an old listener keeps using
its local block; a new listener against an old server gets a 404 from the
fold route and skips summaries.
