/**
 * The retrospective's input builder (ADR 0008): render a session's permanent
 * payload events into one structured transcript for the LLM, enrich failed
 * turns with tool-result evidence extracted from the expiring raw records,
 * roll subagent sessions up compactly, and hold the whole thing to a token
 * budget by compacting the oldest full turns into one-line digests.
 *
 * Everything here is a pure function over fetched rows, so the tests can
 * exercise budget and extraction without a database.
 */
import type {
  ModelRequestEvent,
  NormalEvent,
  ToolCallEvent,
  ToolResultEvent,
  TurnEndEvent,
  TurnStartEvent,
} from "@slopwatch/events";
import type { ChildSessionRollup, SessionRow, StoredEvent } from "../store";

/**
 * Input ceiling in estimated tokens (≈ bytes/3 for mixed CJK/latin). With
 * the 16k output budget and the prompt scaffolding this fits a 200k-context
 * model with headroom.
 */
export const RETRO_INPUT_BUDGET_TOKENS = 150_000;

const BYTES_PER_TOKEN = 3;
/** One tool-call argument blob is capped; head+tail keep ids and shapes. */
const ARGS_CAP_CHARS = 1500;
/** One extracted raw tool-result block is capped the same way. */
export const RAW_EVIDENCE_CAP_CHARS = 4000;
/** Raw enrichment covers at most this many failed turns per run. */
const RAW_EVIDENCE_MAX_TURNS = 12;

export const estimateTokens = (text: string): number =>
  Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN);

const fmtK = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`
      : String(n);

const fmtSecs = (ms: number | undefined): string =>
  ms === undefined
    ? ""
    : ms >= 60_000
      ? `${(ms / 60_000).toFixed(1)}min`
      : `${(ms / 1000).toFixed(1)}s`;

/** Head+tail clip with an explicit cut marker. */
const clip = (text: string, cap: number): string => {
  if (text.length <= cap) return text;
  const head = Math.floor(cap * 0.7);
  const tail = cap - head;
  return `${text.slice(0, head)}\n…[truncated, ${text.length - cap} chars omitted]…\n${text.slice(-tail)}`;
};

type TurnBlock = {
  /** events grouped under one turn:start, in seq order */
  turn: TurnStartEvent | null;
  events: StoredEvent[];
  fullText: string;
  compactLine: string;
  /** failed tool_call_ids in this turn */
  failedCallIds: string[];
  /** the last model_request's seq — the raw record likeliest to echo results */
  lastRequestSeq: number | null;
  enrichedEvidence: string;
};

const usageLine = (u: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
}): string => {
  const parts: string[] = [];
  if (u.input_tokens !== undefined) parts.push(`in ${fmtK(u.input_tokens)}`);
  if (u.output_tokens !== undefined) parts.push(`out ${fmtK(u.output_tokens)}`);
  if (u.cache_read_tokens)
    parts.push(`cache-read ${fmtK(u.cache_read_tokens)}`);
  if (u.cache_write_tokens)
    parts.push(`cache-write ${fmtK(u.cache_write_tokens)}`);
  if (u.reasoning_tokens) parts.push(`reasoning ${fmtK(u.reasoning_tokens)}`);
  return parts.join(", ");
};

const argsLine = (call: ToolCallEvent): string => {
  if (call.args === undefined) return "(no args)";
  let json: string;
  try {
    json = JSON.stringify(call.args);
  } catch {
    json = String(call.args);
  }
  return json === undefined
    ? "(unserializable args)"
    : clip(json, ARGS_CAP_CHARS);
};

/**
 * Deep-walk a raw record collecting anything that looks like a tool result
 * for one of the failed call ids — OpenAI-style tool messages
 * ({tool_call_id, content}), Anthropic-style blocks
 * ({type:"tool_result", tool_call_id, content}), or loose
 * ({tool_call_id, output}) shapes.
 */
export const extractRawEvidence = (
  node: unknown,
  ids: ReadonlySet<string>,
  out: string[] = [],
): string[] => {
  if (Array.isArray(node)) {
    for (const item of node) extractRawEvidence(item, ids, out);
    return out;
  }
  if (typeof node !== "object" || node === null) return out;
  const obj = node as Record<string, unknown>;
  const id = obj.tool_call_id;
  if (typeof id === "string" && ids.has(id)) {
    const content = obj.content ?? obj.output ?? obj.text ?? obj.result;
    const blocks = Array.isArray(content)
      ? content
          .map((b) =>
            typeof b === "object" &&
            b !== null &&
            typeof (b as { text?: unknown }).text === "string"
              ? (b as { text: string }).text
              : typeof b === "string"
                ? b
                : "",
          )
          .filter((s) => s.length > 0)
          .join("\n")
      : typeof content === "string"
        ? content
        : undefined;
    out.push(
      blocks !== undefined && blocks.length > 0
        ? blocks
        : `(result content not extractable from raw record)`,
    );
    return out; // do not descend into the matched result itself
  }
  for (const value of Object.values(obj)) extractRawEvidence(value, ids, out);
  return out;
};

const isTurnStart = (e: NormalEvent): e is TurnStartEvent =>
  e.kind === "turn" && e.event === "start";
const isTurnEnd = (e: NormalEvent): e is TurnEndEvent =>
  e.kind === "turn" && e.event === "end";
const isModelRequest = (e: NormalEvent): e is ModelRequestEvent =>
  e.kind === "model_request";
const isToolCall = (e: NormalEvent): e is ToolCallEvent =>
  e.kind === "tool" && e.event === "call";
const isToolResult = (e: NormalEvent): e is ToolResultEvent =>
  e.kind === "tool" && e.event === "result";

/**
 * The model_request seqs whose raw records should be fetched: the last
 * request of every turn containing a failed tool call, capped to the newest
 * RAW_EVIDENCE_MAX_TURNS such turns.
 */
export const failureRawSeqs = (events: StoredEvent[]): number[] => {
  const turns = groupTurns(events);
  const seqs: number[] = [];
  for (
    let i = turns.length - 1;
    i >= 0 && seqs.length < RAW_EVIDENCE_MAX_TURNS;
    i--
  ) {
    const t = turns[i]!;
    if (t.failedCallIds.length > 0 && t.lastRequestSeq !== null)
      seqs.push(t.lastRequestSeq);
  }
  return seqs;
};

/** Group events into turn blocks (a leading null-turn block holds pre-turn events). */
const groupTurns = (events: StoredEvent[]): TurnBlock[] => {
  const blocks: TurnBlock[] = [];
  let current: TurnBlock | null = null;
  const open = (turn: TurnStartEvent | null) => {
    current = {
      turn,
      events: [],
      fullText: "",
      compactLine: "",
      failedCallIds: [],
      lastRequestSeq: null,
      enrichedEvidence: "",
    };
    blocks.push(current);
  };
  open(null);
  for (const stored of events) {
    const e = stored.event;
    if (isTurnStart(e)) {
      open(e);
      continue;
    }
    if (isTurnEnd(e)) {
      current = null; // events between turns land in a fresh implicit block
      continue;
    }
    if (current === null) open(null);
    current!.events.push(stored);
    if (isToolResult(e) && e.ok === false)
      current!.failedCallIds.push(e.tool_call_id);
    if (isModelRequest(e)) current!.lastRequestSeq = stored.event_seq;
  }
  return blocks;
};

const renderRequest = (callNo: number, e: ModelRequestEvent): string => {
  const lines = [
    `### request r${callNo} — model=${e.model} provider=${e.provider} — ${fmtSecs(e.duration_ms)}`,
  ];
  const usage = usageLine(e.usage ?? {});
  if (usage) lines[0] += ` — tokens: ${usage}`;
  if (e.attempt !== undefined && e.attempt > 1)
    lines[0] += ` — attempt ${e.attempt}`;
  if (e.response_text !== undefined)
    lines.push(`assistant: ${clip(e.response_text, 2200)}`);
  return lines.join("\n");
};

const renderTurn = (
  block: TurnBlock,
  rawBySeq: ReadonlyMap<number, unknown>,
  enrich: boolean,
): TurnBlock => {
  const t = block.turn;
  const header = t
    ? `## Turn ${t.turn_id}${t.parent_turn_id ? ` (branched from ${t.parent_turn_id})` : ""}`
    : "## Pre-turn events";
  const lines: string[] = [header];
  if (t?.user_message !== undefined)
    lines.push(`user: ${clip(t.user_message, 2200)}`);
  if (t?.images?.length)
    lines.push(
      `[user attached ${t.images.length} image(s): ${t.images
        .map((i) => `#${i.n} sha=${i.sha256.slice(0, 12)}…`)
        .join(", ")}]`,
    );
  if (t?.files?.length)
    lines.push(
      `[user attached ${t.files.length} file(s): ${t.files
        .map((f) => `#${f.n} ${f.name} (${f.mime}, ${fmtK(f.size)}B)`)
        .join(", ")}]`,
    );
  let r = 0;
  for (const stored of block.events) {
    const e = stored.event;
    if (isModelRequest(e)) lines.push(renderRequest(++r, e));
    else if (isToolCall(e))
      lines.push(
        `### call ${e.tool_call_id} — ${e.tool}\nargs: ${argsLine(e)}`,
      );
    else if (isToolResult(e)) {
      lines.push(
        e.ok === false
          ? `→ FAILED after ${fmtSecs(e.duration_ms)} — error: ${clip(e.error ?? "(no error text)", 600)}`
          : `→ ok${e.duration_ms !== undefined ? ` (${fmtSecs(e.duration_ms)})` : ""}${e.images?.length ? ` — returned ${e.images.length} image(s)` : ""}`,
      );
    } else if (e.kind === "session" && e.event === "meta") {
      if (e.title) lines.push(`(session meta: title="${e.title}")`);
    }
  }
  // Failure-scene enrichment from the turn's last raw request record.
  if (enrich && block.failedCallIds.length > 0) {
    if (block.lastRequestSeq === null) {
      lines.push("### raw evidence — no model request record to extract from");
    } else {
      const raw = rawBySeq.get(block.lastRequestSeq);
      if (raw === undefined) {
        lines.push(
          "### raw evidence — raw evidence missing (expired past the retention window or not archived)",
        );
      } else {
        const found = extractRawEvidence(raw, new Set(block.failedCallIds));
        lines.push(
          found.length > 0
            ? `### raw evidence for failed call(s) ${block.failedCallIds.join(", ")}\n${found
                .map((f) => clip(f, RAW_EVIDENCE_CAP_CHARS))
                .join("\n---\n")}`
            : `### raw evidence — the stored record did not echo these failed calls' results`,
        );
      }
    }
  }
  block.fullText = lines.join("\n");
  return block;
};

const renderCompact = (block: TurnBlock): string => {
  const requests = block.events.filter((s) => isModelRequest(s.event)).length;
  const calls = block.events.filter((s) => isToolCall(s.event)).length;
  const failed = block.failedCallIds.length;
  let inTok = 0;
  let outTok = 0;
  for (const s of block.events)
    if (isModelRequest(s.event)) {
      inTok += s.event.usage?.input_tokens ?? 0;
      outTok += s.event.usage?.output_tokens ?? 0;
    }
  const userMsg =
    block.turn?.user_message?.slice(0, 100) ?? "(no user message)";
  return `- Turn ${block.turn?.turn_id ?? "(pre-turn)"} — [compacted by budget] — ${requests} requests · ${calls} calls (${failed} failed) · in ${fmtK(inTok)}, out ${fmtK(outTok)} — user: ${userMsg}`;
};

const renderChild = (c: ChildSessionRollup): string[] => {
  const lines = [
    `## child session ${c.session_id} — agent ${c.agent}${c.title ? ` — "${c.title}"` : ""}`,
    `totals: ${c.turns} turns · ${c.model_requests} requests · ${c.tool_calls} calls (${c.tool_errors} failed) · tokens in ${fmtK(c.input_tokens)}, out ${fmtK(c.output_tokens)}, cache-read ${fmtK(c.cache_read_tokens)}${c.sub_sessions > 0 ? ` · spawns ${c.sub_sessions} nested subagent(s)` : ""}`,
    `tools: ${c.tools.map((t) => `${t.tool}×${t.calls}`).join(", ") || "(none)"}`,
  ];
  if (c.task_preview) lines.push(`task: ${c.task_preview}`);
  if (c.first_user_message)
    lines.push(`first user message: ${clip(c.first_user_message, 300)}`);
  return lines;
};

export type Transcript = {
  text: string;
  estimatedTokens: number;
  budgetTokens: number;
  /** Turns demoted to one-line digests by the budget. */
  compactedTurns: number;
  /** Failed turns enriched with raw evidence. */
  enrichedTurns: number;
};

export type TranscriptInput = {
  session: SessionRow;
  events: StoredEvent[];
  children: ChildSessionRollup[];
  /** raw records keyed by the model_request event_seq that carried them */
  rawBySeq: ReadonlyMap<number, unknown>;
};

export const buildTranscript = (
  input: TranscriptInput,
  budgetTokens: number = RETRO_INPUT_BUDGET_TOKENS,
): Transcript => {
  const { session, events, children, rawBySeq } = input;
  const blocks = groupTurns(events);
  // Per-turn enrichment decision: at most the newest RAW_EVIDENCE_MAX_TURNS
  // failed turns get raw evidence, matching failureRawSeqs' fetch list.
  let enrichSlots = RAW_EVIDENCE_MAX_TURNS;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    const enrich = block.failedCallIds.length > 0 && enrichSlots > 0;
    if (enrich) enrichSlots -= 1;
    renderTurn(block, rawBySeq, enrich);
  }
  const enrichedTurns = RAW_EVIDENCE_MAX_TURNS - Math.max(enrichSlots, 0);

  // Header: identity facts, captured totals, the latest machine summary.
  const header: string[] = [
    "# Session transcript (rebuilt from captured events)",
    `session: ${session.session_id}`,
    `agent: ${session.agent} · user: ${session.user_id ?? "?"}${session.title ? ` · title: ${session.title}` : ""}${session.task_preview ? ` · task: ${clip(session.task_preview, 200)}` : ""}`,
    `captured totals: tokens in ${fmtK(session.total_input_tokens)}, out ${fmtK(session.total_output_tokens)}, cache-read ${fmtK(session.total_cache_read_tokens)} (session-level columns)`,
  ];
  const start = events.find(
    (s) => s.event.kind === "session" && s.event.event === "start",
  );
  if (
    start &&
    start.event.kind === "session" &&
    start.event.event === "start"
  ) {
    header.push(
      `environment: cwd ${start.event.cwd} · host ${start.event.hostname}${start.event.git_remote ? ` · git ${start.event.git_remote}` : ""}${start.event.agent_version ? ` · agent ${start.event.agent_version}` : ""}`,
    );
    if (start.event.parent_session_id)
      header.push(
        `NOTE: this session is itself a subagent of ${start.event.parent_session_id}`,
      );
  }
  const end = [...events]
    .reverse()
    .find((s) => s.event.kind === "session" && s.event.event === "end");
  if (end && end.event.kind === "session" && end.event.event === "end")
    header.push(`session ended: ${end.event.reason ?? "unknown reason"}`);
  const lastSummary = [...events]
    .reverse()
    .find((s) => s.event.kind === "session" && s.event.event === "summary");
  if (
    lastSummary &&
    lastSummary.event.kind === "session" &&
    lastSummary.event.event === "summary"
  )
    header.push(
      `[machine-generated rolling summary — a reading aid, NOT evidence]\n${clip(lastSummary.event.body, 1500)}`,
    );

  // Budget walk, newest turn first: full blocks stay until the budget bites;
  // everything older degrades to its compact line.
  const childrenBlock =
    children.length > 0
      ? [
          `# Subagent sessions (${children.length}) — compact rollups; audit a child's interior by running a retrospective on the child session itself`,
          ...children.flatMap(renderChild),
        ].join("\n")
      : "";
  const reserve =
    estimateTokens(header.join("\n")) + estimateTokens(childrenBlock) + 200;
  let remaining = budgetTokens - reserve;
  const kept: string[] = [];
  const compacted: string[] = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    const cost = estimateTokens(block.fullText);
    if (remaining - cost >= 0) {
      remaining -= cost;
      kept.unshift(block.fullText);
    } else {
      compacted.unshift(renderCompact(block));
    }
  }
  const truncated = compacted.length > 0;
  const budgetNote = truncated
    ? `\n[the ${compacted.length} oldest turn(s) above were compacted to one-line digests to fit the input budget — their full detail is unavailable; do not draw strong conclusions about their interiors]`
    : "";
  const text = [
    ...header,
    "",
    ...(truncated ? compacted : []),
    ...(truncated ? ["[--- full detail resumes here ---]"] : []),
    ...kept,
    ...(childrenBlock ? ["", childrenBlock] : []),
    budgetNote,
  ].join("\n");
  return {
    text,
    estimatedTokens: estimateTokens(text),
    budgetTokens,
    compactedTurns: compacted.length,
    enrichedTurns,
  };
};
