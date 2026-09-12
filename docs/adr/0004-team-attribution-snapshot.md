# Team attribution: snapshot the team on the session at creation

The Team entity (v2) gives each User exactly one team, and each Session records the `team_id` its User belonged to at session creation. Usage is counted where it happened: when someone changes teams, their past sessions stay attributed to the team they worked in, and team-level reports never silently rewrite history. The scenario that decided it: a developer spends 40M tokens in team A in September and moves to team B in October — September's team-A report must still show 40M. `team_id` is nullable; sessions whose user has no team surface as an "unassigned" bucket in the leaderboard and filters, and the admin assigns people through the team-configuration UI — no backfill script, no synthetic default team. DRI stays org-wide; the stored team makes a team-scoped filter a trivial later increment.

## Rejected

- **Live join at read time** (session → user → current team). Reports would follow people across reorgs: October's view of September would show those 40M tokens under team B, and month-end reconciliation becomes impossible.
- **Multi-team membership table.** Real flexibility, purchased with an ambiguity tax in every consumer — leaderboard rows per user, DRI scope, retention policy would each need a tie-break rule for which team a session belongs to. One team per user needs none. If a genuine multi-team user appears, adding the table is additive.

## Consequence

Team reports answer "where did the usage happen," not "who owns these people today"; a current-org-chart view, if wanted, must join users to teams at read time. Reorganizations cost no data work by design — and buy no history rewrite, also by design.
