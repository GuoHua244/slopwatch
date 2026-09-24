# Session retrospectives: per-user LLM credentials, budgeted transcripts, one angle per run

The first server-side LLM capability. Until now the only LLM feature was the
**Summary** — produced on the observed machine with the developer's own key,
shipped as an ordinary Event, a reading aid and never evidence. The
**Retrospective** (see CONTEXT.md) inverts the direction: the Server itself
calls an LLM over events it already stores to critique how a session's work
was done — efficiency, token spend, tool and process choices — rather than
compress what happened. That inversion forced the decisions below; the name
deliberately avoids "review" (the DRI's human evaluation) and "summary".

## Decision

1. **Artifact model.** A new `retrospectives` table, one row per run with
   the resolved prompt snapshot, status (`pending`/`running`/`completed`/
   `failed`), result text, generating model, and token usage. Runs execute
   on an in-process queue — no external broker; the DB row is the task
   state, and a server restart marks orphaned `running` rows failed.
   Multiple rows per session are expected: angles are compared across runs.
2. **Transcript fidelity.** The prompt input is built from the permanent
   payload events: user messages, full tool arguments, per-call ok/error,
   per-request response text, model, usage, and durations — MCP tools,
   skills, and commands are distinguishable by tool-name convention. Full
   tool-result content survives only in the expiring `raw` column, so raw
   is fetched only for turns containing failed tool calls, extracted down
   to the relevant result blocks, and held to a per-run size budget: over
   budget, the oldest failure turns truncate first (head+tail excerpts) and
   every truncation is explicitly marked; sessions whose raw has expired
   say so in the transcript. Subagent sessions enter as compact rollups
   (task, usage totals, turn/tool counts, tool histogram); auditing a
   subagent's interior means running a retrospective on the child session
   itself.
3. **Whose key.** Per user. Each user configures their own LLM endpoint,
   model, and API key on their profile page; the key is stored server-side,
   never returned in full by any read (masked), and a run is billed to the
   triggering user's key. A user without configured credentials sees no
   retrospective affordance, and the API rejects their triggers. The
   org-wide preset angle texts live in the settings table (admin-editable,
   seeded defaults). One run = one preset angle plus an optional custom
   supplement, or a pure custom prompt (the free-form angle). Seeded
   angles: efficiency & token waste; session hygiene; tooling & method;
   process & engineering judgement; prompting quality; free-form. Prompt
   texts demand structured Markdown with turn-level evidence citations,
   explicit uncertainty, honesty about truncation, and Chinese output by
   default. Each row snapshots the fully resolved prompt, so any report is
   reproducible against exactly the text that produced it.
4. **Visibility and audit.** Triggering and reading follow the session read
   scope — the same owner-or-admin check as the events endpoint: whoever
   can read a session's events can trigger retrospectives on it and read
   its results. Every trigger appends an `audit_log` entry (who, when,
   which session, which angle).
5. **Rendering.** A dedicated Retrospectives tab in the session detail
   view, rendered with react-markdown without rehype-raw: raw HTML in LLM
   output is escaped, not executed — the transcript embeds captured session
   content, so prompt injection through stored material is a live surface.
   Every report displays the generating model and its input/output token
   usage.
6. **Guardrails.** A per-run input token budget with the estimate shown
   before triggering and oldest-first truncation under the budget; per-user
   concurrency of one and a small server-wide worker pool; an output token
   cap with one automatic budget-raising retry on `finish_reason: length`
   (usage accumulated across attempts — the pattern the Summary fold
   already proved); a call timeout that marks the run failed; failed rows
   keep their error summary and offer one-click rerun as a new row.

## Rejected

- **One org-level key (env var or settings row).** Cost would be
  unattributable and any member's trigger would spend shared quota; a
  per-user key keeps cost self-contained and the model choice in the hands
  of the person who pays for it.
- **Full-fidelity raw transcripts.** Unbounded size (sessions with
  multi-million-token subagents exist) and already expired for old
  sessions; selective failure-turn raw under budgets keeps the scenes that
  matter without unpredictable cost.
- **Multi-angle single run.** Cheaper in input tokens but shallower per
  angle and brittle — one weak angle ruins a combined report; one row per
  angle composes cleanly with the multi-row artifact model.
- **Plain-text rendering; storing retrospectives as Events.** Long
  structured reports need real Markdown; and Server-generated analysis must
  not enter the Event stream, which is Listener→Server captured evidence.

## Consequence

The Server gains its first outbound LLM dependency and a new failure mode:
provider outages and exhausted keys now surface as failed run rows rather
than silent gaps. Plaintext LLM keys sit in the database — acceptable for a
self-hosted, single-operator deployment, and never echoed through the API.
Retrospective text is generated opinion influenced by session content: it
renders escaped, is labeled with its model and cost, and, like the Summary,
is never evidence. Preset prompts are operator-editable prose, so report
quality partially depends on whoever edits them; the seeded defaults are
intentionally thorough at the cost of input tokens.
