# Slopwatch agent instructions

Project-level rules override the user-global conventions where they conflict.

## Commit messages

- Write commit messages in **English**, matching the existing log style
  ("Add CI workflow...", "Rename packages/wire..."). The repo's docs, code
  comments, and history are all English; the user-global Chinese-message
  convention does not apply here.
- AI attribution is still forbidden (Co-Authored-By, Claude/Anthropic/ZCode
  references, noreply addresses). Note: a **global PreToolUse hook** blocks
  these tokens inside any `git commit` command — including the product name
  "ZCode". Commit messages here must avoid that token entirely; the product
  context is carried by file paths (`listeners/zcode`) and docs.

## Quality gate

`bun run ci` (prettier format:check + tsgo typecheck + bun test) must pass
before any milestone is called done. Run `bun run format` after editing.
Tests that need Postgres read `DATABASE_URL_TEST` (see `.env.example`) and
skip cleanly when it is absent.

## Project context

- Windows is the primary platform (ADR 0001); line endings are forced to LF
  via `.gitattributes` — never disable that.
- Ubiquitous language lives in `CONTEXT.md` (authoritative). Architecture
  decisions: `docs/adr/` and `research/v1-architecture-decisions.md`;
  the milestone plan is `research/tracer-bullet-plan.md`.
