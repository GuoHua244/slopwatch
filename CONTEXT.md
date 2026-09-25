# Slopwatch

Self-hosted, on-prem observability platform for coding agents. See [`research/v1-architecture-decisions.md`](./research/v1-architecture-decisions.md) and [`research/coding-agent-ingestion.md`](./research/coding-agent-ingestion.md).

## Language

**Coding agent**:
An AI coding tool that runs on a developer's machine (Claude Code, Codex CLI, Pi, OpenCode, Copilot CLI, ZCode).
_Avoid_: assistant, bot, AI tool.

**Session**:
One logical run of one coding agent for one developer in one cwd, containing a DAG of turns.
_Avoid_: conversation, chat, run.

**Turn**:
One user message plus the full assistant response, including all tool-use loops inside it.
_Avoid_: message, exchange, step.

**Model request**:
One HTTP call the agent makes to the model provider during a turn.
_Avoid_: API call, inference, completion.

**Subagent**:
A coding agent spawned by another coding agent (e.g. via Claude Code's Task tool), treated as a child session.
_Avoid_: sub-task, nested agent, delegate.

**Listener**:
The per-agent integration that observes one coding agent on a developer's machine, normalizes its events, and ships them to the Server — one per supported coding agent.
_Avoid_: sidecar, adapter, capturer, probe, collector.

**Server**:
The single self-hosted process that receives events from Listeners, stores them in Postgres, serves the dashboard, and hosts the admin plane — one per organization.
_Avoid_: backend, hub, daemon, collector.

**User**:
A person with an identity in one Slopwatch organization — may run coding agents, review sessions, administer the Server, or any combination.
_Avoid_: developer, account. ("Developer" is a role a **User** plays when running a coding agent; not every **User** is a developer. "Member" is reserved for the non-admin **Role** — it is not a synonym for **User**.)

**Team**:
A named group of **Users** within one Slopwatch organization; each **User** belongs to exactly one **Team**.
_Avoid_: group, squad, project, org.

**DRI (Directly Responsible Individual)**:
A role a **User** plays: reviews other users' **Sessions** by pulling from a filterable firehose; the only DRI-exclusive action is marking a session as reviewed.
_Avoid_: reviewer, assignee, approver, inbox owner.

**Role**:
The authorization tier of a **User** (ADR 0006): `admin` runs the admin plane and reads org-wide; `member` reads only their own **Sessions** and usage. Stored on the user row; granted by an admin or the `SLOPWATCH_ADMINS` boot list.
_Avoid_: permission, access level, admin status. ("Member" here is the Role value — not a word for **User** in general — and Role is not the same as DRI, which is a review responsibility, not an authorization tier.)

**Event**:
A normalized record a **Listener** produces and ships to the **Server** — the unit of communication between them. Sessions, Turns, and Model requests are all carried as Events. The shared package that defines the Event schema and the typed Listener→Server client is `@slopwatch/events`; the TypeScript type is `NormalEvent` (to avoid colliding with the global DOM `Event`).
_Avoid_: message, payload, wire format, record.

**Issuer**:
Whoever minted a bearer token: the **Server** (admin-minted, stored hashed in `tokens`) or the org's OIDC IdP (verified against its published JWKS, ADR 0005). The token's wire shape is the same either way — a Listener can never tell which Issuer stood behind it.
_Avoid_: SSO, identity provider without naming which Issuer.

**Summary**:
A rolling digest of a **Session**'s progress so far, generated on the observed machine with the developer's own LLM key and shipped as an **Event** — a reading aid for someone joining mid-run, never evidence of what happened.
_Avoid_: recap, digest, abstract. (Not a **Retrospective**.)

**Retrospective**:
An LLM-generated process analysis of a **Session**, produced by the **Server** from that Session's captured **Events** — turns, tool calls, model requests, Subagent activity. The LLM call is made with the triggering **User**'s own LLM credentials (configured per user; a User who has not configured credentials sees no Retrospective affordance), so its token cost belongs to the User who triggered it. Its aim is to critique how the work was done (efficiency, token spend, approach, process) and suggest improvements, not to restate what happened: a **Summary** compresses the work for reading, a **Retrospective** critiques the work for improvement. Like a Summary it is generated text, never captured evidence.
_Avoid_: review (that is the DRI's human evaluation), analysis, insight, postmortem, 复盘→use Retrospective in code.

**Audit log**:
The append-only record of every mutation to the Server's own data — Users, Teams, tokens, settings, Sessions, review markers, and notes — capturing who acted (a User, the operator bypass, or the system), when, on what target, and the before/after change; hard deletes carry a snapshot of what vanished (ADR 0007). Written by the Server at the moment each mutation succeeds; read through the admin plane.
_Avoid_: activity log, operation log, history (collides with captured Events), changelog.

**Feedback**:
A note a **User** files about Slopwatch itself from the dashboard — a defect noticed while reviewing **Sessions** (content that went missing, data that looks wrong, agent **Events** the Server failed to handle) or a feature suggestion. Each Feedback carries one kind — Missing content / Wrong data / Compatibility / Feature suggestion / Other — and may reference the **Session** it was noticed on (feature suggestions carry none) and carry optional attached files. It is an observation recorded for the maintainers: the admin plane lists submitted Feedback and an admin may delete one (audited), but there is no status, assignee, reply, or tracking workflow.
_Avoid_: bug report (it also carries feature suggestions), issue (implies a tracker workflow), report (collides with **Review**), 问题反馈→use Feedback in code.

## Relationships

- A **User**'s **Role** decides what they may see: admins get the admin plane and the org-wide read; members get their own **Sessions** only.
- A **User** belongs to exactly one **Team**; membership can change over time.
- A **Session** is attributed to the **Team** its **User** belonged to when the Session was created; later membership changes do not move existing Sessions.
- A **Session** contains a DAG of **Turns**; most agents produce a linear DAG, Pi can branch.
- A **Turn** contains zero or more **Model requests**.
- A **Subagent** is a **Session** whose `parent_session_id` points to the spawning **Session** and whose `spawned_by_turn_id` points to the **Turn** that launched it.
- A **Listener** produces **Sessions**, **Turns**, and **Model requests** for exactly one **Coding agent**; it runs either as a subprocess (Claude Code, Codex, Copilot, ZCode) or as an in-process extension (Pi, OpenCode).
- Many **Listeners** POST to one **Server**; the **Server** is the only component that talks to Postgres.
- **Listeners** and the **Server** communicate by exchanging **Events** defined in `@slopwatch/events`.
- A **Feedback** optionally references the **Session** it was noticed on — only a **Session** its filer can open (the same owner-or-admin rule as **Retrospectives**); it records the filer's observation about Slopwatch itself, never evidence of what happened in that **Session**.
- A **Summary** is produced by a **Listener** and arrives as an **Event**; a **Retrospective** is produced by the **Server** from already-stored **Events** and never enters the Event stream. Both are generated text, never evidence.

## Example dialogue

> **DRI:** "This **Session** cost $14 — where did it go?"
> **Dev:** "Most of it was one **Turn** where the agent did 22 tool calls; each was a **Model request** charged separately. The rest is a **Subagent** I spawned with the Task tool — it's a child **Session** with its own cost."

## Flagged ambiguities

- "turn" was used early to mean "one API call to the model" — resolved: that's a **Model request**. A **Turn** is the user-visible cycle and can contain many **Model requests**.
- "session" in Pi has branches; these are **not** separate **Sessions** but nodes in a single **Session**'s DAG.
- Resumes (Codex `codex resume`, Pi resume, Claude Code compaction-continue) are unresolved — defer until v1 is running.
- "listener" collides with in-agent event-listener terminology (Pi `pi.on(...)`, OpenCode plugin events). Accepted for now; revisit if docs get confusing.
- "user" vs "developer" — resolved: the entity is **User**; "developer" is a role (the subset of **Users** who run coding agents observed by Slopwatch). The prototype leaderboard column labelled "Developer" is a role-filtered view of **Users**, not a separate entity.
- "wire" vs "events" — resolved: the Listener↔Server channel is described in terms of **Events**, not "wire." `packages/wire` has been renamed `packages/events` (package name `@slopwatch/events`). The TypeScript type stays `NormalEvent` to avoid colliding with the global DOM `Event` type.
- "which team does a session belong to" — resolved: the **Team** its **User** belonged to at session creation (usage counts where it happened); a live join against the current org chart is explicitly rejected. **DRI** stays org-wide when **Teams** land.
