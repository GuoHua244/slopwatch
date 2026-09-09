# Bun on Windows: Validation Results

Empirical results from the ADR 0001 risk-surface spikes, run on the primary
target platform. Date: 2026-09-08. Machine: Windows 10 19045 x64, Bun 1.4.2
(installed via `npm i -g bun` through npmmirror — the distribution channel works
in the target environment). Spike code: [`spikes/bun-windows/`](../spikes/bun-windows/)
(throwaway, kept for reproduction; not a product surface).

## ADR 0001 risk surfaces

| Surface                 | Test                                                                                                                                        | Result         | Evidence / caveat                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres client (`pg`)  | module load + client init + TCP dial to `127.0.0.1:5432` with no server running                                                             | PASS (partial) | Loads cleanly, dials, fails in 4ms with a proper `ECONNREFUSED` — no native crash. **Round-trip closed 2026-09-09**: against native PostgreSQL 18 (slopwatch role, JSONB payload writes/reads, transactions) in M3 — endpoint tests and live smoke all green. |
| File watching           | `node:fs` `watch` on a JSONL file, 3 appends, tail-read from last known size                                                                | PASS           | 3/3 appends produced events at 0–1ms latency; appended bytes reconstructed exactly — the Listener's JSONL-tail path is viable.                                                                                                                                |
| Local IPC (named pipes) | echo server/client over `\\.\pipe\...` via (a) `Bun.listen({unix})` + `Bun.connect`, (b) `node:net` `createServer`/`connect` on a pipe path | PASS (both)    | Both paths echo round-trip: `Bun.listen({unix})` maps to a Windows named pipe. Killed processes can leave a pipe name occupied (`EADDRINUSE`) — use per-session pipe names (we pass `--session-id` anyway).                                                   |
| OS keychain             | (a) Credential Manager via `cmdkey` add/list/delete spawned from Bun; (b) DPAPI `CurrentUser` Protect/Unprotect round-trip via PowerShell   | PASS (both)    | `cmdkey` write/list/delete all exit 0; DPAPI round-trip in 389ms. Caveat: `cmdkey` cannot read a stored password back programmatically (that needs a native `CredRead`) — **user-scoped DPAPI is the practical v1 token store on Windows**.                   |
| `bun build --compile`   | compile a hello-world, run the `.exe`                                                                                                       | PASS           | Compiles in 214ms, runs correctly. Size **~86 MB** — the same ballpark as Node SEA's ~80 MB, so binary size is not a differentiator between the two.                                                                                                          |

## Repo quality gate on Windows

- `bun install --frozen-lockfile` works (41 packages, 2.2s; the `tsgo`
  win32-x64 binary installs fine).
- `bun run ci` **failed on a fresh Windows checkout**: Git's `autocrlf` produces
  a CRLF working tree and Prettier's default `endOfLine: "lf"` flagged 19 files.
  Fixed by committing `.gitattributes` (`* text=auto eol=lf`) plus one
  `prettier --write .`. After that the full gate (format:check + tsgo typecheck
  - `bun test`) passes on Windows.
- **CI gap**: `.github/workflows/ci.yml` runs ubuntu-latest only — the failure
  above is invisible to CI. Add windows-latest to the matrix.

## ZCode hook catalog (settles the sidecar-lifecycle assumption)

From the official `zcode-guide` docs shipped with the client, confirmed against
the live hook configuration on this machine:

- **Exactly seven events**: `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
  `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Stop`.
  **There is no `SessionEnd`** (and no `SubagentStop`/`Notification`/`PreCompact`).
  The v1 assumption "sidecar exits on `SessionEnd`" does not hold for ZCode —
  candidate replacement: exit on `Stop` + idle timeout, decided per-adapter.
- `SessionStart` matcher values (`startup|resume|clear|compact`) expose
  resume/compact transitions to hooks.
- Matcher is a case-sensitive regex over the tool name (aliases `Task` ↔ `Agent`,
  `Write`/`Edit` ← `ApplyPatch`).
- Hook `type: "process"` runs an argv without a shell — the portable choice on
  Windows; `timeoutMs` is milliseconds (the `command` type's `timeout` is
  seconds — a classic trap).
- Hooks run **inline**; `async` has no runtime effect — a `SessionStart` hook
  that spawns the sidecar must detach and return immediately.
- Template variables include `${ZCODE_SESSION_ID}` (`CLAUDE_SESSION_ID`
  compatible) — the sidecar can be handed its session on the command line.
- Hook stdout is parsed as strict JSON (extra keys fail validation); exit code
  `2` blocks. Config-file hooks are **disabled by default**
  (`hooks.enabled: true` required) — the installer must set this. Workspace
  config (`<repo>/.zcode/config.json` or `zcode.json`) also works, so a
  per-repo listener install is possible.

## Still open

2. The ZCode sidecar exit design (`Stop` + idle timeout vs. liveness probing).
3. windows-latest in the CI matrix.
