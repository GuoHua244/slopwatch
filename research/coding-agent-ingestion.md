# Coding Agent Ingestion: Capture Surfaces Across Agents

Research notes for Slopwatch — a self-hosted, open-source observability platform
for coding agents. This document captures what we learned about the six target
agents and why a per-agent ingestion strategy is unavoidable.

**Target agents (v1):** Claude Code, OpenAI Codex CLI, Pi (`@mariozechner/pi-coding-agent`), OpenCode, GitHub Copilot CLI, ZCode.

---

## The headline finding

There is no single capture mechanism that works well across all six agents.

- Hooks alone are insufficient for most of them (payloads lack message content, or the hook system is flag-gated, or coverage is thin).
- JSONL-on-disk tailing alone is insufficient for some (OpenCode is migrating to SQLite; Pi's schema is versioned and has bumped 3x recently; Claude Code and Copilot JSONL schemas are undocumented).
- OpenTelemetry is not a unifier: only Claude Code and Codex have meaningful CLI-level OTel. Pi and Copilot emit none at the CLI level; OpenCode requires a community plugin.
- Proxy-via-base-URL capture is blocked for Copilot (cert-pinned GitHub auth), available on the others, but only captures request/response — not tool results, edits, reasoning, or turn boundaries.

The right strategy is **per-agent adapters, each using that agent's most stable surface, normalizing into a shared internal event schema.**

---

## Per-agent capture surfaces

### Claude Code

| Surface            | Status                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hooks              | 24+ events (`SessionStart`, `PostToolUse`, `SubagentStop`, etc.). Payloads include `session_id`, `transcript_path`, event-specific fields — **but not full message content**. |
| On-disk transcript | `~/.claude/projects/<hash>/<session-uuid>.jsonl`. Schema **undocumented**, reverse-engineered by community.                                                                   |
| OpenTelemetry      | Rich. Spans (`claude_code.interaction`, `llm_request`, `tool`, `hook`), metrics, log events. Prompts/tool content opt-in via env vars.                                        |
| Live streaming     | No native spectate API. Tail JSONL or stream OTel spans (~5s batching).                                                                                                       |
| Proxy              | Not viable (Anthropic auth).                                                                                                                                                  |

**Takeaway.** Hooks identify _when_ things happen but can't carry the content — full reconstruction requires reading the JSONL anyway. JSONL tail is mandatory; hooks are useful as triggers (session end → upload) and for OTel-style aggregates.

### OpenAI Codex CLI

| Surface            | Status                                                                                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hooks              | `hooks.json` system with `PreToolUse`/`PostToolUse`/`UserPromptSubmit`/`Stop`. **Flag-gated (`codex_hooks`), off by default, Windows-excluded.** Also a stable `notify` config for lifecycle events.                               |
| On-disk transcript | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<uuid>.jsonl`. Schema **documented-but-evolving**; treated as semi-stable; resumes survive across versions. Rich event types (`turn.started`, `item.*`, token usage on `turn.completed`). |
| OpenTelemetry      | Opt-in via `[otel]` config block. OTLP HTTP/gRPC. Emits conversation/request/tool events. `codex exec` emits no metrics; `codex mcp-server` emits nothing.                                                                         |
| Live streaming     | `codex exec --json` streams JSONL on stdout. `codex app-server` RPC is the cleanest live-observe channel.                                                                                                                          |
| Proxy              | Viable. `openai_base_url` or custom `[model_providers.proxy]`. Gateway integrations (Kong/LiteLLM) documented.                                                                                                                     |

**Takeaway.** JSONL tailing is the right primary: always on, complete, schema is the same as `--json` stdout output. Hooks too brittle to depend on given flag/Windows gaps. OTel is useful as a complement for live spans where enabled.

### Pi (`@mariozechner/pi-coding-agent`)

| Surface            | Status                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hooks              | First-class `pi.on(event, handler)` TypeScript extension API. Rich events: session lifecycle, agent/turn, tool_call/result (mutable, middleware-style), `before_provider_request`/`after_provider_response`. |
| On-disk transcript | `~/.pi/agent/sessions/--<cwd-slug>--/<ts>_<uuid>.jsonl`. Tree-structured DAG. **Documented, versioned schema: v1→v2→v3.** Schema has changed 3x; 0.67.6 is current.                                          |
| OpenTelemetry      | None. `pi --mode json` gives a typed stdout event stream instead.                                                                                                                                            |
| Live streaming     | `pi --mode rpc` (LF-delimited JSONL, bidirectional). In-process SDK via `createAgentSessionRuntime()`.                                                                                                       |
| Proxy              | Viable. Custom providers configured in `~/.pi/agent/models.json`.                                                                                                                                            |

**Takeaway.** The extension API is the single stable contract — more stable than the JSONL schema, which is under active churn. An in-process TS extension is the right adapter. JSONL tail is a fallback for unsupervised capture, but must watch `SessionHeader.version`.

### OpenCode

| Surface            | Status                                                                                                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hooks              | First-class plugin system (JS/TS, loaded from `.opencode/plugin/` or config). Rich events: session, message, `tool.execute.before/after` (mutable), permissions, file/LSP/command/TUI/shell. `chat.params` + auth hooks can intercept model requests. |
| On-disk transcript | `~/.local/share/opencode/storage/`. **Migrating from JSON files to SQLite** — legacy layout still authoritative for blobs. Schema in `packages/sdk/js/src/gen/types.gen.ts`.                                                                          |
| OpenTelemetry      | Not built-in. Community plugin `opencode-plugin-otel` exists.                                                                                                                                                                                         |
| Live streaming     | Headless server `opencode serve` exposes SSE at `GET /event` and `/global/event`, plus REST endpoints. SDK wraps as `client.event.subscribe()`.                                                                                                       |
| Proxy              | Viable. Per-provider `baseURL` overrides.                                                                                                                                                                                                             |

**Takeaway.** The plugin API and `/event` SSE stream are the stable contracts. **Do not depend on on-disk files** — the SQLite migration will break file-tailers. Read authoritative state via the SDK client, not the filesystem.

### GitHub Copilot CLI (2025 agentic CLI)

| Surface            | Status                                                                                                                                                                                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hooks              | Six events: `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `errorOccurred`. Config at `~/.copilot/hooks/hooks.json` or `.github/hooks/hooks.json`. Only `preToolUse` can gate (`deny` enforced, `allow`/`ask` not). Payloads thin but include prompt/tool args/result. |
| On-disk transcript | `~/.copilot/session-state/<sessionId>/events.jsonl` + SQLite index at `~/.copilot/session-store.db`. **Schema undocumented** — treat as unstable, pin to CLI version. Markdown export via `--share=PATH`.                                                                                                 |
| OpenTelemetry      | No CLI-level OTel. OTel lives in `@github/copilot-sdk` (spans, OTLP HTTP/file exporters). Irrelevant for CLI users.                                                                                                                                                                                       |
| Live streaming     | `--output-format=json` gives JSONL on stdout. No pub-sub for attaching to a running interactive session — tail `events.jsonl`.                                                                                                                                                                            |
| Proxy              | **Not viable.** `HTTPS_PROXY` honored for network routing, but no base-URL override (issue #2283 open); cert pinning and GitHub OAuth make MITM of model traffic impractical.                                                                                                                             |

**Takeaway.** Hooks + JSONL tail combined. Hooks for real-time low-latency signals (session start/end, tool calls); JSONL tail for full event fidelity. Include `--share` Markdown export on session end as a fallback. Accept schema instability and pin to tested CLI versions.

### ZCode

Observed on a Windows machine (2026-09-08). Target users run ZCode on Windows, so this adapter is Windows-first.

| Surface            | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hooks              | Hook configuration in `~/.zcode/cli/config.json` (event names, tool matchers, template variables); **Surveyed (2026-09-08).** Exactly **seven events**: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Stop` — **no `SessionEnd`, no `SubagentStop`**. Matcher is a case-sensitive regex over the tool name (aliases `Task` ↔ `Agent`); `SessionStart` matcher values expose `startup/resume/clear/compact`. `type: "process"` runs an argv without a shell (`timeoutMs` in ms — the `command` type's `timeout` is seconds) — the portable choice on Windows; hooks run **inline** (`async` is a no-op), so a spawning hook must detach and return immediately. `${ZCODE_SESSION_ID}` is expanded in args; stdout must be strict JSON or exit codes (`2` blocks). Config-file hooks are **disabled by default** (`hooks.enabled: true`); workspace config (`<repo>/.zcode/config.json` / `zcode.json`) also works. **Workspace hooks are additionally gated behind a one-time in-client trust approval** (observed live 2026-09-09: sessions started while hooks are "pending trust" fire nothing; after the user selects trust, subsequent SessionStart fires normally — the shipped client docs claiming no trust gate are stale). `slopwatch install` must tell the user to approve the prompt.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| On-disk transcript | `~/.zcode/cli/rollout/model-io-sess_<session-uuid>.jsonl` — one JSON line per completed **Model request**: `completedAt`, `durationMs`, `requestId`, `attempt`, `model.{modelId, providerId, role, source, variant}`, plus the full raw provider request body. **Subagents get their own files** (`model-io-sess_subagent_agent_<id>.jsonl`, `querySource: "subagent"`), mapping directly onto the child-Session model. Confirmed in M2 (2026-09-09): records also carry `startedAt`, `sessionId` (authoritative), `turnId` (turn linkage per record), `querySource` (`main_turn` / `session_title` / `subagent`), and a `response` with `usage` (camelCase token counts) and `toolCalls` (`{id, name, input}`) — turn linkage, tool calls, and token usage ARE derivable (turn-event synthesis stays server-side). **Parent attribution (verified 2026-09-29 via the internal db): `traceId` is session-scoped and constant across all turns of a session (a 17-turn session has exactly one), and a subagent record's `traceId` equals its parent session's — the db `session` table even carries `trace_id` + `parent_id` columns — so matching a subagent file's first-record traceId against the live tail's own identifies the owner uniquely, and two concurrently open main sessions never cross-adopt.** Schema still undocumented — pin defensively. **Rollout files are pruned AND rewritten**: a subagent rollout was observed deleted after its session ended, and an app restart was observed to REWRITE a main-session rollout down to the post-resume context window (200+ records became 30, early records gone) — replay only works for surviving files, cursor-based live capture is the reliable path, and sidecar cursors need a shrink guard (file can get smaller). |
| SQLite store       | `~/.zcode/cli/db/db.sqlite` (+ WAL) — likely the authoritative session store; schema undocumented. Same caveat as OpenCode: do not build on undocumented formats without version pinning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| OpenTelemetry      | None observed at the CLI level.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Live streaming     | No spectate API observed. fs-watch the rollout JSONL (~100ms) is the practical channel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Proxy              | Unknown — whether the model-provider base URL is configurable has not been verified.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Takeaway.** Hooks as triggers + rollout JSONL tail for model requests. The load-bearing fact from the survey: **ZCode has no `SessionEnd` hook**, so the "sidecar exits on SessionEnd" lifecycle does not transfer from Claude Code — candidate: exit on `Stop` + idle timeout, decided in the adapter. Hooks run inline, so the `SessionStart` hook must spawn the sidecar detached (a `process`-type argv hook, no shell) and return immediately. `slopwatch install` must set `hooks.enabled: true`; a per-repo install via workspace config is possible. Capture self-heals across idle gaps: the sidecar persists a byte cursor (end of last complete line) and the installer also registers UserPromptSubmit — a message in an already-open session re-spawns a dead sidecar, which resumes from the cursor with zero duplicates. Bun-on-Windows feasibility of the sidecar primitives (fs-watch tail, named-pipe IPC, DPAPI token storage) is validated in [`bun-windows-validation.md`](bun-windows-validation.md).

---

## Cross-cutting patterns

### 1. Every agent has a local event bus and an append-only log

Even where the contracts differ, the shape is identical: subscribe to events in-process, or tail an append-only store on disk. This suggests a uniform **adapter interface** inside Slopwatch:

```ts
interface AgentAdapter {
  detect(): Promise<boolean>; // is this agent installed / configured?
  install(): Promise<void>; // wire up hooks/plugins, idempotent
  start(emit: (ev: NormalEvent) => void): Promise<Stop>;
}
```

Each adapter uses whatever capture surface is actually stable for its agent; the rest of the system only sees `NormalEvent`.

### 2. Schemas differ and drift — normalization is load-bearing

No two agents use the same event names, the same turn boundaries, or the same tool-call representation. Pi has a tree DAG with branches; OpenCode has discriminated parts; Claude Code has a flat message stream with subagent transcripts in separate files; Codex has typed `turn.*` / `item.*` events; Copilot has a mostly-undocumented JSONL.

Normalization cannot be deferred. The internal schema must cover:

- **Session**: id, agent, agent version, cwd, user, start/end, parent (for forks/resumes).
- **Turn**: user prompt → assistant response cycle, with token usage.
- **Message**: role, content blocks (text, reasoning/thinking, image, tool_call, tool_result).
- **Tool event**: call → result pair with duration, success/failure, bytes in/out.
- **Model request**: provider, model, tokens, latency.
- **Agent-specific payload**: raw original event retained for fidelity and debugging.

### 3. Live observation is achievable everywhere, but not uniformly

- Claude Code / Codex / Copilot: fs-watch JSONL append (~100ms latency, effectively live for humans).
- Pi: in-process extension event bus (sub-ms).
- OpenCode: `/event` SSE or in-process plugin bus.

For the manager-spectate feature, ~100ms latency via fs-watch is acceptable. A push channel is a "nice to have" only for agents that already expose one.

### 4. Proxy capture is not a general strategy

Copilot kills it (cert pinning + GitHub OAuth). Even where it works (Codex, Pi, OpenCode), a proxy only sees wire traffic — it misses tool results, file edits, reasoning items, turn boundaries, and hook-reported metadata. Proxy is a bonus signal at best; never a primary capture path.

### 5. Setup friction is the product

For an open-source self-install tool, the install ceremony is the UX. The ceiling is: "install one daemon, it detects your agents, wires them up idempotently, and starts shipping events." Users who have to hand-edit five hook config files will never onboard. This forces adapters to be installable, not just consumable.

---

## Implications for Slopwatch v1

1. **Per-agent adapters, normalized internally** (option (c) from the design). No uniform strategy across agents.
2. **Primary capture per agent:**
   - Claude Code → JSONL tail, hooks as session-end triggers.
   - Codex → JSONL tail (`rollout-*.jsonl`).
   - Pi → TS extension subscribing to lifecycle/turn/tool/provider events.
   - OpenCode → plugin subscribing to session/message/tool events (never touch disk).
   - Copilot → hooks + JSONL tail combined.
   - ZCode → rollout JSONL tail (model IO) + hooks as triggers; hooks surveyed (seven events, no `SessionEnd` — sidecar exits on `Stop` + idle timeout instead).
3. **Internal `NormalEvent` schema** is a v1 deliverable, not a v2 refactor.
4. **`npx slopwatch install`** detects installed agents and wires each correctly; per-agent weirdness never surfaces to the user.
5. **Version pinning and schema-drift handling** must be built in from the start for Claude Code, Copilot, Pi, and ZCode JSONLs.
6. **No proxy path in v1.** Revisit for Codex/Pi/OpenCode if granular wire-level model traffic becomes valuable.

---

## Open questions left for later documents

- What exact fields does `NormalEvent` carry? What do we drop?
- How does the adapter handle resumed / forked / compacted sessions (especially Pi's DAG and Codex resume)?
- Where does the local daemon persist buffered events when the backend is unreachable?
- How is per-user identity bound to sessions (git config email? OS user? explicit login)?
- What's the on-prem deployment shape (single binary + Postgres? Docker Compose?)?

---

## Sources

**Claude Code**

- [Hooks reference](https://code.claude.com/docs/en/hooks.md)
- [How Claude Code works: sessions](https://code.claude.com/docs/en/how-claude-code-works.md)
- [Agent SDK observability (OTel)](https://code.claude.com/docs/en/agent-sdk/observability)

**Codex CLI**

- [Repo](https://github.com/openai/codex) · [Hooks docs](https://developers.openai.com/codex/hooks) · [PR #9796](https://github.com/openai/codex/pull/9796)
- [Advanced config](https://developers.openai.com/codex/config-advanced) · [Config reference](https://developers.openai.com/codex/config-reference)
- [Session/rollout discussion #3827](https://github.com/openai/codex/discussions/3827)
- [OTel gaps issue #12913](https://github.com/openai/codex/issues/12913) · [SigNoz Codex monitoring](https://signoz.io/docs/codex-monitoring/)
- [MCP docs](https://developers.openai.com/codex/mcp) · [App server](https://developers.openai.com/codex/app-server)

**Pi**

- [pi-mono repo](https://github.com/badlogic/pi-mono/) · [coding-agent README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md)
- [extensions.md](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/extensions.md)
- [session.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session.md) · [json.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/json.md)
- [Author blog post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)

**OpenCode**

- [Plugins](https://opencode.ai/docs/plugins/) · [Server](https://opencode.ai/docs/server/) · [SDK](https://opencode.ai/docs/sdk/) · [MCP](https://opencode.ai/docs/mcp-servers/)
- [Storage/database (DeepWiki)](https://deepwiki.com/sst/opencode/2.9-storage-and-database)
- [opencode-plugin-otel](https://github.com/DEVtheOPS/opencode-plugin-otel)

**GitHub Copilot CLI**

- [Hooks configuration](https://docs.github.com/en/copilot/reference/hooks-configuration) · [Using hooks](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks)
- [Chronicle (session data)](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle) · [CLI config dir](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)
- [CLI command reference](https://docs.github.com/en/copilot/reference/cli-command-reference)
- [Copilot SDK OpenTelemetry](https://github.com/github/copilot-sdk/blob/main/docs/observability/opentelemetry.md)
- [MCP servers](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers) · [Issue #2283: base URL override](https://github.com/github/copilot-cli/issues/2283)

**ZCode**

- Local filesystem survey on a Windows machine (2026-09-08): `~/.zcode/cli/config.json` (hook configuration keys), `~/.zcode/hooks/`, `~/.zcode/cli/rollout/model-io-*.jsonl`, `~/.zcode/cli/db/db.sqlite`.
