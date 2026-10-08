# CodeBuddy: Capture Surfaces

Measured on a Windows machine (2026-10-08) against the installed product, not
against documentation. Every claim below is backed by a file on disk, a line
in a session log, or a string extracted from the shipped bundle. Where the
task brief or the vendor docs disagree with what this machine does, **the
machine wins** — a capture strategy built on the documented shape would have
collected nothing here.

Companion survey for the other six agents:
[`coding-agent-ingestion.md`](coding-agent-ingestion.md).

---

## 0. What is actually installed

| Item                      | Measured value                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Product                   | **CodeBuddy CN** desktop application (Electron), `CodeBuddy CN.exe`                                        |
| Install root              | `D:\software\CodeBuddy CN`                                                                                 |
| Electron/editor version   | `1.106.1` (`resources/app/package.json`)                                                                   |
| Agent extension           | `genie` / `coding-copilot` v`3.10.0`, publisher `Tencent-Cloud`                                            |
| Agent version in payloads | `4.12.1` (hook payload `version` field)                                                                    |
| Model endpoint            | `https://copilot.tencent.com/v2`                                                                           |
| Model seen in sessions    | `hy4-preview-f` (`modelName: "Hy4 preview"`)                                                               |
| `client` (hook payload)   | `"CodeBuddyIDE"`                                                                                           |
| Standalone agent CLI      | **none.** `bin/buddycn` is the Electron wrapper for `app/out/cli.js`; `bunce`/`codebuddy` is not on `PATH` |

Two brief-level facts did **not** survive contact with this machine:

1. **There is no `~/.codebuddy/projects/<project>/<session>.jsonl`.** There is
   no `projects/` directory at all, and the string `.jsonl` does not occur
   anywhere in the shipped agent bundle (21 MB index.js) — no transcript is
   written as JSONL here. The real layout is a per-message JSON tree under the
   app's own data dir (§2).
2. **No headless mode exists**, so step 2 of the planned spike (run a
   throwaway session with `-p`) is impossible. The sample used throughout this
   document is the live session that produced it — better evidence than a
   synthetic one, and the only kind available.
3. The version gates quoted in the brief (`v1.16.0+` for hooks, `v2.52.4` for
   MCP Pre/PostToolUse) belong to a different versioning scheme than this
   install carries (`1.106.1` editor / `3.10.0` extension / `4.12.1` reported
   by hooks). Version pinning for this agent therefore pins the _extension_
   version, and silently tolerates anything else.

### `~/.codebuddy` inventory (as of 2026-10-08 18:40)

```
~/.codebuddy/
  settings.json          user settings — hooks live here (was plugins-only)
  mcp.json
  expert-history.json
  diagnostics/           (empty)
  logs/memwatch/         cli-memwatch-*.log
  memery/                <conversation-id>_memery.md, user-memery-state.json
  inspiration/           <conversation-id>/cards
  plugins/, skills-marketplace/   marketplace caches, unrelated to capture
```

Observed during the session being measured: **`~/.codebuddy` received no
session writes at all.** The only file that changed in a 60-minute window was
`settings.json` (our own edit) plus marketplace caches. Nothing here is worth
tailing.

---

## 1. Hooks — supported, CC-shaped, and they need no review

### Config

User scope `~/.codebuddy/settings.json`; project scope
`<dir>/.codebuddy/settings.json`. Project-level hooks are gated on **workspace
trust**:

```
[SettingConfigManager] [WorkspaceTrust] workspace trusted=false, project-level hooks disabled
[WorkspaceTrustDispatcher] [WorkspaceTrust] trust granted, project-level hooks enabled
```

An untrusted workspace silently drops project hooks — the same trap ZCode has
(`coding-agent-ingestion.md`, "ZCode"), so a per-project install must tell the
user to grant trust.

### Claim vs measurement: does an external edit need in-app review?

**No.** Editing `~/.codebuddy/settings.json` from outside the application took
effect in the _already-running_ session, with no restart and no interaction
whatsoever:

```
18:46:59  settings.json written externally (1 PostToolUse + UserPromptSubmit + Stop entries)
18:47:36  [HookExecutor] Executing hook command: bun …/probe.mjs …
```

The mechanism is visible in the bundle: `SettingConfigManager` runs
`ensureUserWatcher()` on every `getAllSettings()` and keeps a
`SCOPE_CACHE_TTL` of 30 s, so a picked-up config lands within half a minute of
the write. Recorded because the brief asserted the opposite — an unattended
`install` **does** arm itself here. The installer should still say "hooks go
live within ~30 s, or immediately in a new session", because the cache means
the first fire can lag the installer's own "installed!" message.

### Which events actually fire

Counts are `[HookExecutor] Got N hook config(s) for event X` lines in one
real session log, across ~90 tool calls and ~10 user prompts:

| Event              | Queried | Our command executed                                       |
| ------------------ | ------: | ---------------------------------------------------------- |
| `PreToolUse`       |      90 | yes (config added mid-session → subsequent fires executed) |
| `PostToolUse`      |      89 | yes — the reliable trigger, once per tool call             |
| `SessionStart`     |       2 | not reachable mid-session (fires only at session open)     |
| `UserPromptSubmit` |       1 | never re-fired despite 10+ prompts                         |
| `Stop`             |       0 | **never queried**                                          |
| `SessionEnd`       |       0 | **never queried**                                          |

`Stop` and `SessionEnd` never reached the executor, so **this agent has no
usable session-end hook** — the ZCode situation again
(`coding-agent-ingestion.md` takeaway), not the Claude Code situation. A
listener here must end itself on idle/max-lifetime; nobody will tell it to
stop. `UserPromptSubmit` firing once is not enough to hang respawn on.
`PostToolUse` is the only dependable heartbeat, exactly like decision 19's
fix for ZCode.

### Payload shape

Superset of Claude Code's. Measured `PostToolUse` payload key set:

```json
{
  "hook_event_name": "PostToolUse",
  "session_id": "775cc5f8f8604b798be88bbf9bc3c06d",
  "transcript_path": "C:\\Users\\…\\history\\4c38fe68bcba317535704f74187134e3\\775cc5f8f8604b798be88bbf9bc3c06d\\index.json",
  "cwd": "D:\\software\\CodeBuddy CN",
  "tool_name": "Write",
  "tool_input": { … },
  "tool_response": { … },
  "model": "hy4-preview-f",
  "generation_id": "00592a8d23944ff7b9422c179366547d",
  "client": "CodeBuddyIDE",
  "version": "4.12.1",
  "agent_type": { … }
}
```

Bundle evidence confirms the same builder is used for `SessionStart` (plus
`source`), `UserPromptSubmit` (plus `prompt`), `Notification` (plus
`notification_type`), `Stop` (plus `stop_hook_active`, `loop_count`) — i.e. the
CC core fields plus vendor extras. Exit code `2` blocks (CC semantics); any
other non-zero logged as `Hook exited with non-blocking error code 1`, so a
crashing listener never breaks the user's session.

### Two traps in the payload

**`cwd` lies.** It is `userContext.env.workspace`, and on this machine every
single probe recorded `D:\software\CodeBuddy CN` — the _editor install
directory_, not the workspace (`d:\studySpace\slopwatch`). Shipping it into
`session.start.cwd` would attribute every session to the IDE's own folder.
The fix is §3's reverse map.

**`transcript_path` is a directory pointer, not a log.** It points at a
`index.json` that is rewritten wholesale on every write (single line, grows in
place). Line-tailing it is meaningless; §2's file-per-message tree is what is
actually append-only.

---

## 2. On-disk transcript — the primary surface

Root, measured:

```
%LOCALAPPDATA%\CodeBuddyExtension\Data\<instance-id>\CodeBuddyIDE\<instance-id>\
  history\<workspace-hash>\<conversation-id>\
      index.json            ← per-conversation manifest (rewritten, grows)
      messages\<message-id>.json   ← ONE FILE PER MESSAGE, written once
  check-point\<workspace-hash>\<conversation-id>\meta.json
  file-tree\<workspace-hash>\<conversation-id>\file-tree.json
  plan-task\<workspace-hash>\<conversation-id>\meta.json
```

- `<instance-id>`: a UUID stable per machine/app installation (here
  `0d54d05f-44cd-4a97-9470-348b316b76e0`, repeated twice in the path).
- `<workspace-hash>`: **md5 of the lower-cased Windows workspace path** — see
  §3.
- `<conversation-id>`: 32 lowercase hex, **this is the hook's `session_id`**.

### `index.json` (conversation manifest)

Single-line JSON, 4.9 KB → 11.5 KB over the measured session, mtime advancing
with every assistant step:

```json
{
  "messages": [
    {
      "id": "1fc7b522dffc457486d3a99629366b4b",
      "type": "text",
      "role": "user",
      "isComplete": true
    },
    {
      "id": "d0e251f82b41488ca2d456dd4b18e7fe",
      "type": "text",
      "role": "assistant",
      "isComplete": false
    },
    {
      "id": "cc7951d200064e10b02ac237e02ccc19",
      "type": "text",
      "role": "tool",
      "isComplete": true
    }
  ],
  "requests": [
    {
      "id": "00592a8d23944ff7b9422c179366547d",
      "type": "craft",
      "messages": ["1fc7b5…", "d0e251…"],
      "state": "running"
    }
  ]
}
```

Three roles only — `user`, `assistant`, `tool` — and **`requests[]` is the
turn grouping**: `messages` lists the message ids belonging to one request and
`state` goes `running` → (completed/…). A lean conversation replays as
`{"messages":[],"requests":[]}`.

### Message files

Pretty-printed JSON, five keys, written **once** — every mtime still equals
the file's creation moment hours later, and byte sizes are unchanged:

```json
{
  "role": "assistant",
  "message": "{\"role\":\"assistant\",\"content\":[…],\"providerOptions\":{…}}",
  "id": "f47957d9eb514aba9c91a6e0cbe0843b",
  "extra": "{\"requestId\":\"…\",\"modelId\":\"hy4-preview-f\",…}",
  "createdAt": "2026-10-08T10:38:07.946Z"
}
```

`message` and `extra` are **double-encoded** (JSON strings, not objects).
`message.content` carries the AI SDK block vocabulary:

- `{"type":"text","text":"…"}`
- `{"type":"reasoning","text":"…"}`
- `{"type":"tool-call","toolCallId":"call_…","toolName":"list_dir","args":{…}}`
- `{"type":"tool-result","toolCallId":"call_…","toolName":"read_file","result":{…}}`

`extra` keys observed across 42 real messages (grouped, with counts):

| Key set                                                                                |      n |
| -------------------------------------------------------------------------------------- | -----: |
| `requestId, modelId, modelName, isHelperMessage, traceId`                              |     20 |
| `requestId, modelId, modelName, isHelperMessage, traceId, toolStatus`                  |     15 |
| `requestId, modelId, modelName, isHelperMessage, toolStatus, traceId`                  |      4 |
| plus `tasks` / `sourceContentBlocks` / `inputPhrase` / `selectionContexts` / `command` | 1 each |

`toolStatus` embeds `{ [toolCallId]: { ready, status, args, result, pendingConfirmation } }`
— the tool result is available **inside the assistant message**, which is why
`tool`-role messages are not always emitted. Both shapes must be read.

### The missing piece: **no token counts in the transcript**

Every one of the 42 messages was checked for a `usage` key in both `message`
and `extra`. There are none. Token accounting lives somewhere else entirely
(§4).

### Secondary files

- `history/<ws-hash>/index.json` — the **conversation list**, and its `name`
  field is the first user message, i.e. a free session title:

  ```json
  {
    "conversations": [
      {
        "id": "775cc5f8…",
        "type": "craft",
        "name": "# 任务：为 slopwatch 新增 CodeBuddy listener…",
        "createdAt": "2026-10-08T10:29:12.370Z",
        "lastMessageAt": "2026-10-08T10:53:20.556Z",
        "selectedModelId": "hy4-preview-f",
        "chatMode": "craft"
      }
    ],
    "current": "775cc5f8…"
  }
  ```

- `file-tree/<ws>/<conv>/file-tree.json` — touched files with absolute paths
  and old/new content snapshots per edit. Not needed for v1; noted because it
  is the only place that leaks a workspace-independent absolute path.
- `check-point/…/meta.json` and `plan-task/…/meta.json` — empty / todo list.
  `plan-task/…/meta.json` held the session's own task list.

---

## 3. Recovering the real cwd (the reverse map)

Two independent measurements make this exact, not heuristic:

1. `md5("d:\\studySpace\\slopwatch") = 4c38fe68bcba317535704f74187134e3` —
   exactly the `<workspace-hash>` directory for this session. Variants with
   forward slashes, capitalised drive letters, or a leading `/` do **not**
   match, so the input is precisely the lower-cased Windows path.
2. `%APPDATA%\CodeBuddy CN\User\workspaceStorage\<id>\workspace.json` holds
   `{"folder":"file:///d%3A/studySpace/slopwatch"}` — the IDE's own record of
   which folder each workspace root belongs to.

So: enumerate `workspaceStorage/*/workspace.json`, decode each folder URI to a
Windows path, md5 the lower-cased form, and `<workspace-hash> → absolute path`
is authoritative. That gives us a trustworthy `cwd` for `session.start`
**even with no hook payload at all** — which is what makes transcript-only
capture viable for sessions that were already running when the listener was
installed.

Fallback order when the workspace is unknown to any `workspace.json`: the
transcript's own file-tree paths, then `process.cwd()`. Never the hook's
`cwd` field alone — it pointed at the IDE install directory in 100% of
probes.

---

## 4. Token usage — only in the agent log, keyed by message id

```
%LOCALAPPDATA%\CodeBuddyExtension\Logs\CodeBuddyIDE\<YYYY-MM-DD>\<workspace-name>__<workspace-hash>.log
```

Real lines (one per assistant step):

```
[2026/10/8 18:38:04.276] [Info] [BaseAgent:craft] [00592a8d23944ff7b9422c179366547d]  notifyStepEnd, step: 1, requestId: 00592a8d23944ff7b9422c179366547d, messageId: d0e251f82b41488ca2d456dd4b18e7fe, usage: {"inputTokens":12633,"outputTokens":59,"totalTokens":12692,"cacheTokens":4224,"cachedWriteTokens":0,"cachedMissTokens":8409,"lastTokens":12692,"credit":0,"thinkingTokens":59}, isMaxTokenLimit: false, isMaxStepLimit: false, hasReactiveTool:false, isContentFilter: false
[2026/10/8 18:38:04.276] [Info] [AgentReporter] [3b4e456c29373c181d8f681f9c309d51]  Step execution metrics: step=1, duration=4381ms, usage={…}
```

Properties that matter:

- **Keyed by `messageId` + `requestId`**, both of which exist in the
  transcript's `extra` — the join is exact, no heuristics.
- `inputTokens` is the _cumulative prompt_ for that step (12 633 → 15 714
  across two steps), i.e. per-model-request prompt tokens, not a delta. Same
  accounting shape as Claude Code's per-request usage.
- `duration=…ms` on the `AgentReporter` line supplies `duration_ms`.
- `requestId` is per-request; `traceId` is the whole session's trace and is
  constant across its turns (the same fact ZCode relies on for parent
  attribution).
- Log file is **per workspace per day**, shared by every conversation in that
  workspace — hence the join must be by `messageId`/`requestId`, not by
  position. It rotates at midnight, so a long-lived listener has to
  re-resolve its log path by date.
- `cachedMissTokens` and `credit` have no slot in `TokenUsage`; they are
  dropped, not smuggled in.

Mapping to `@slopwatch/events`:

| CodeBuddy field     | `TokenUsage` field   |
| ------------------- | -------------------- |
| `inputTokens`       | `input_tokens`       |
| `outputTokens`      | `output_tokens`      |
| `cacheTokens`       | `cache_read_tokens`  |
| `cachedWriteTokens` | `cache_write_tokens` |
| `thinkingTokens`    | `reasoning_tokens`   |

---

## 5. Capture strategy for the codebuddy listener

Ranked by what this machine proved available, not by what the vendor
documents:

1. **Transcript first.** Poll the conversation's `index.json` for new
   message ids (it is rewritten whole, so a line-cursor would be wrong — diff
   the parsed `messages`/`requests` arrays instead), read each new
   `messages/<id>.json` once, and walk them in the order `index.json` gives.
   This alone yields turns, tool calls, tool results, models, request ids —
   and works for a conversation that started before the listener existed.
2. **Usage joined from the log.** Tail the workspace log for
   `notifyStepEnd`/`Step execution metrics`, attach each to its
   `messageId`. Usage that has not landed yet ships when it does; usage that
   never lands still leaves the evidence events intact.
3. **Hooks as triggers only.** `SessionStart`, `UserPromptSubmit` and
   `PostToolUse` spawn the detached listener (`transcript_path` hands us the
   conversation directory; `PostToolUse` is the re-spawn heartbeat that
   decision 19 introduced for ZCode). Hooks carry no usage and no prompt text
   we trust more than the transcript, so they never author events on their own
   beyond lifecycle markers.
4. **No end hook → self-terminating listener.** Idle timeout (5 min, matching
   the other listeners' decision-19 value) plus a max lifetime. Each new
   generation re-asserts `session.start` so the dashboard's last-write-wins
   status flips back to live, exactly as `listener-shared` already does.

Lifecycle and shipping semantics are **not** re-implemented: they come from
`@slopwatch/listener-shared` (`createShipPipeline` for the flusher + disk
queue, `isListenerAlive` heartbeat+pid check, `runAgentDrain` for the orphan
sweep, `createTurnDigest` for rolling summaries, `atomicWriteJson` /
`readSettingsJson` for non-destructive install). Everything CodeBuddy-specific
— path resolution, usage joining, message normalization — is the adapter layer
in `listeners/codebuddy/src/`.

Subagents were **not** observed to exist on this machine: the log's
`subagent-manager` only loads a built-in catalogue, and no child conversation
appeared during the session. Child-session capture (parent/child Session
modelling per ADR 0008) is therefore left unimplemented until a real sample
exists, rather than guessed at.

---

## Open questions / watch list

- The sample is one Windows machine, one product build, one model. The md5
  workspace-hash happens to be pinned by an exact match, but it is an
  undocumented internal — the listener must tolerate a hash it cannot reverse
  and fall back instead of failing.
- Whether `SessionEnd`/`Stop` fire in some other chat mode (the measured
  session was `chatMode: "craft"`) is untested; the listener must not depend
  on them regardless.
- The `message`/`extra` double-encoding and the `toolStatus`-inline results
  are both undocumented; unit tests pin the observed shapes so drift shows up
  as a test failure rather than silent data loss (verdict per §2 of
  `coding-agent-ingestion.md`: "schemas differ and drift — normalization is
  load-bearing").
- Multi-workspace / multi-conversation: `history/<ws>/index.json` lists every
  conversation for that workspace, which is enough for a future
  `replay`/backfill mode but is not needed for the live path.
