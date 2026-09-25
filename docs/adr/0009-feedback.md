# Feedback: a stateless signal channel filed where the problem was noticed

The dashboard is read-mostly: Users mark reviews, leave comments and notes,
but when the capture itself looks wrong — a missing turn, wrong tokens, an
agent's **Events** the Server failed to handle — there is nowhere to say so,
and feature suggestions have no home at all. **Feedback** (see CONTEXT.md)
gives every User that voice from two dashboard entries. The name is chosen
over "bug report" (it also carries feature suggestions), "issue" (implies a
tracker workflow), and "report" (collides with **Review**).

## Decision

1. **One entity, an optional session anchor.** A `feedback` table: filer,
   kind, text, nullable `session_id`, timestamp. Defect feedback points at
   the **Session** it was noticed on; feature suggestions carry none. Two
   entries feed it — a button on the session detail page (anchor prefilled)
   and a global nav entry (no anchor). No turn anchoring: the text carries
   the specifics, and at this organization's scale the maintainers open the
   session themselves.
2. **Kinds.** A fixed set of five: Missing content / Wrong data /
   Compatibility / Feature suggestion / Other. The first two split the
   defect classes actually debugged here — capture-side loss versus data
   that arrived but is wrong (tokens, cost, summary); Compatibility covers
   an agent's Events the Server fails to adapt.
3. **Who files.** Any signed-in User, no rate limit — the surface is
   authenticated and internal. Session-anchored Feedback follows the
   Retrospective rule: only a Session the filer can open (owner-or-admin,
   otherwise 404). Visible equals fileable.
4. **Form.** The kind selector plus a required text capped at 2,000
   characters, plus optional file attachments for what words cannot
   carry — up to 10 files of 20 MB each under a permissive allowlist
   (common images: png/jpg/gif/webp; common documents: pdf, text-like,
   csv/json, office files). Attachments reuse the session-attachment
   conventions — content-addressed by sha256 with dedup; image previews
   render the stored bytes inline at CSS size, the repo's existing
   "thumbnail" pattern (no image-processing pipeline). No auto-captured
   view context (noise with a maintenance cost).
5. **Reading and deleting.** A read-only Feedback tab in the admin plane —
   time, filer, kind, text, session link, attachments (inline image
   previews, click to view the full bytes). No webhook push, no status,
   assignee, or reply: it is a signal channel, not a ticket system. An
   admin may delete a row; the filer has no readback anywhere — a submit
   confirmation is the only acknowledgment, which also keeps an admin's
   feedback on a member's session from leaking to that member.
6. **Audit.** `feedback.create` on submit (user actor) and
   `feedback.delete` on admin deletion — the all-mutations audit pattern
   every route here already follows.

## Rejected

- **Webhook push per Feedback.** The org webhook could announce each
  submission for near-zero code, but at the expected volume push noise in
  the team chat outweighs immediacy; the admin-plane list is the single
  reading surface, and anything urgent reaches the maintainers by chat
  anyway.
- **A status field / ticket semantics.** A signal channel exists to be
  read, not tracked; status, assignees, and replies are the first steps
  toward a helpdesk, and there is no one to answer replies.
- **Turn anchoring.** Precision pays off with a triage workflow at
  volume; there is neither. A nullable turn reference would double the
  form surface for value the maintainers get by opening the session.
- **Two entities (session defect reports vs product feedback).** One table
  with a kind does the sorting; two surfaces would duplicate routes, UI,
  and permissions.

## Consequence

Every kind of gripe now has a home, and the maintainers' existing habit of
checking the admin plane becomes the intake. Feedback rows are small,
exempt from the raw-payload TTL by construction (the prune job touches only
`events.raw`), and cascade away only when an admin deletes the anchored
Session, their attachments cascading with them. Attachments also introduce
the first browser-initiated file upload into the Server — until now files
arrived only through Listener Events — reusing the attachment storage
conventions under the caps above. Because there is no status and no readback, a filer never learns
whether anyone looked — accepted: the signal is the product, follow-up
happens in ordinary conversation, and if volume ever demands triage, a
status field is an additive migration.
