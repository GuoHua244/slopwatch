# Web Dashboard UI Spec (2026-09 redesign)

Audience: this file is for the dashboard developer, sits next to the code.
The user feedback driving it is quoted per section; acceptance criteria at the
bottom map 1:1 to that feedback.

## Personas

- **Lead (admin role)** — owns the team's agent spend and conduct. Jobs: see
  who is active and on what, sanity-check spend, manage members/teams,
  configure the webhook, confirm capture health. Reads Leaderboard/Admin.
- **Member (member role)** — uses agents to work. Jobs: find their own
  sessions, check their own usage, keep their token working. Reads
  Sessions/Me. Never sees Leaderboard/Admin.

## Design direction

The product watches machines work. The interface splits the voices:
**the machine's data speaks in mono** (ids, counts, model names, clocks),
**the human's chrome speaks in sans** (labels, titles, buttons). Keeping each
voice in its lane is the identity; the previous all-mono chrome read as
terminal clutter.

Layout follows reading gravity (Gutenberg): lists that get scanned anchor the
top-left rail; pages that get read center a **stage** column so the eye's
terminal zone lands on content, not void. One living element — the breathing
pulse dot — marks everything live (header status, active sessions, running
sessions). Nothing else moves.

### Tokens

| Role                   | Value                                                                    |
| ---------------------- | ------------------------------------------------------------------------ |
| bg / panel / raised    | `#0f141b` / `#161d27` / `#1c2431`                                        |
| line / line-soft       | `#243040` / `#1d2632`                                                    |
| text / dim / faint     | `#dce4ef` / `#8b97a6` / `#647182`                                        |
| accent (live/positive) | `#47c78e`                                                                |
| danger                 | `#e5585d`                                                                |
| link                   | `#82b4e8`                                                                |
| font-ui                | Segoe UI Variable / Segoe UI / system-ui / Microsoft YaHei               |
| font-mono              | Cascadia Mono / ui-monospace / Consolas                                  |
| radius                 | 8px cards, 6px controls                                                  |
| type scale             | 11 label · 12 meta · 13 body · 14 title-sm · 16 title · 21 page · 26 kpi |

### Layout system

- **Rail + stage** (sessions): 320px rail left, stage column (max 1120px,
  centered in the remaining space) right.
- **Stage** (all other pages): centered column, `max-width: min(1200px, 100% - 48px)`;
  settings/me narrow to 860px.
- **Header**: brand (pulse + wordmark, mono) · nav · spacer · live pill ·
  avatar chip → `#/me`. The avatar chip is the human anchor at the Z-pattern's
  terminal position on every screen.
- Responsive: rail 280px under 1280; stacked sessions (rail above stage) under
  920; KPI/facts grids collapse to 2/1 columns; wide tables scroll inside
  `.table-scroll` cards instead of stretching the page.

## Page specs

**Sign in** — full-viewport, single centered card: pulse mark, wordmark, one
line of copy, token field, primary button. No header. (Was: tiny top-left form.)

**Sessions** — rail: compact head with count + team select pill (no caps
label, fit-content). List items: pulse-dot + title + relative time; user ·
agent · in/out sub-line; italic task preview. Detail stage: 21px title +
status chips; review row (state + DRI actions only — no sign in/out here,
identity lives on Me); facts grid; summary/usage/turns as cards; note button
as an inviting ghost "+ Note"; floating rocket button bottom-right appears
after scrolling, smooth-scrolls to top.

**Leaderboard** — toolbar: team select pill + "active today" / "active this
week" toggle chips. Table trimmed 14 → 9 columns; team folds under developer
name; tokens merge to one `in / out` column; sparkline and 7d delta stack in
one cell; requests/cache/top-agent move to the drill-down. Stays inside the
stage (no full-bleed).

**Admin** — stage column; roomier tab row. Users/Teams: add-forms in cards,
tables in scroll cards, status/role as colored chips. Sessions: grouped by
user — collapsible group headers (member, session count, in/out, last
activity) over per-session rows. Settings: task-oriented cards, 860px column,
plain copy ("Post one message to your team chat when a session ends"), status
pill per card. Health: KPI cards (sessions, events, quarantined 24h, last
event) + quarantine table card.

**Me** — centered 860px: profile card (avatar, name, role/team chips), usage
card (KPI grid), account card with the single sign-out. All identity/auth
actions live here and nowhere else.

## Acceptance (maps to user feedback)

1. No horizontal page scrollbar at 1366×768, 1920×1080, 2560×1440; tables
   scroll within cards on narrow screens.
2. Content stages are centered; no page reads as left-anchored with dead
   right space; avatar chip is an obvious Me entry point.
3. Long session pages have a rocket back-to-top per NN/g guidelines (fixed,
   bottom-right, appears after ~1.5 screens, keyboard accessible).
4. No sign-in/out or identify buttons outside Me.
5. Sign-in is a centered designed card.
6. Note affordance is a visible, inviting button on every turn.
7. Leaderboard has team + today + this-week filters in one toolbar; checkbox
   labels are adjacent to their boxes.
8. Leaderboard fits the stage and reads without left-to-right strain.
9. Admin (incl. Teams panel selects) shares the control language; stage is
   centered.
10. Admin sessions groups by user for the lead's per-member triage.
11. Settings cards are legible to a non-technical lead (outcome-first copy).
12. Health leads with KPI cards.
