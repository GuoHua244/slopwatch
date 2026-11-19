import type { NormalEvent } from "@slopwatch/events";

/** One row of GET /sessions — mirrors the Server's SessionRow. */
export type SessionSummary = {
  session_id: string;
  agent: string;
  user_id: string | null;
  first_seen_at: string;
  /** Last ingest into the session; null when no event has landed yet. */
  last_event_at: string | null;
  last_seq: number;
  title: string | null;
  task_preview: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  /** v3 decision 31: waste counters mirrored from the Server's SessionRow. */
  failed_tool_calls: number;
  repeated_calls: number;
  /** Parent session for subagent sessions; null for top-level sessions. */
  parent_session_id: string | null;
};

/** One entry of GET /sessions/:id/events — a NormalEvent plus its seq. */
export type StoredEvent = { event_seq: number; event: NormalEvent };

/** The accountability marker (decision 10): one review per session. */
export type ReviewRow = {
  session_id: string;
  reviewer_id: string;
  reviewed_at: string;
};

/** A review note, session-level (turn_id null) or pinned to one turn. */
export type CommentRow = {
  comment_id: number;
  session_id: string;
  turn_id: string | null;
  author_id: string;
  body: string;
  created_at: string;
};

/** One signed-in user's lifetime footprint, scoped to them on the server. */
export type MeUsage = {
  sessions: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  turns: number;
  tool_calls: number;
  /** Model-grain all-time token sums; cost stays a client-side estimate. */
  model_totals: ModelRollupRow[];
};

/**
 * GET /me — the identity behind the reader's bearer token, their role, and
 * their own usage; everything the profile page shows in one payload.
 */
export type MeInfo = {
  user: string;
  role: "admin" | "member";
  email: string | null;
  team_name: string | null;
  is_dri: boolean;
  /**
   * ADR 0011: whether password sign-in is available — false until the user
   * sets a password (first sign-in is via token), so the profile page and
   * the sign-in gate know which door to offer.
   */
  password_set: boolean;
  created_at: string | null;
  /**
   * ADR 0008: the user's own LLM credentials for retrospectives — masked
   * (the api key only ever comes back as a `••••` hint), null when unset.
   */
  llm: { endpoint: string; model: string; api_key_hint: string } | null;
  usage: MeUsage;
};

/** One retrospective run of GET /sessions/:id/retrospectives (ADR 0008). */
export type RetroRow = {
  id: number;
  session_id: string;
  /** The triggering user — the run billed to their LLM credentials. */
  user_id: string;
  /** Preset angle id or "custom". */
  angle: string;
  supplement: string | null;
  status: "pending" | "running" | "completed" | "failed";
  /** Streaming progress while running; null on pending and terminal rows. */
  phase: "waiting_first_byte" | "streaming" | null;
  /** Cumulative streamed output (content + reasoning chars). */
  output_chars: number | null;
  /** Rolling preview of the generated text while streaming; null otherwise. */
  output_tail: string | null;
  /** Server clock at the last progress write — the hang-detection signal. */
  heartbeat_at: string | null;
  result: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  reasoning_tokens: number | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

/** One selectable retrospective angle of GET /retrospectives/angles. */
export type RetroAngleInfo = { id: string; title: string };

/** POST /sessions/:id/retrospectives' picture of what the run will cost. */
export type RetroEstimate = {
  input_tokens: number;
  budget_tokens: number;
  compacted_turns: number;
  raw_enriched_turns: number;
};

/** Row of GET /rollups — per-day turn/tool/waste counts for one user. */
export type DailyRollupRow = {
  user_id: string;
  /** UTC day, "YYYY-MM-DD". */
  day: string;
  turns: number;
  tool_calls: number;
  failed_tool_calls: number;
  repeated_calls: number;
};

/** Row of GET /rollups — per-hour turn/tool/waste counts for one user. */
export type UserHourlyRollupRow = {
  user_id: string;
  /** UTC hour, "YYYY-MM-DDTHH". */
  hour: string;
  turns: number;
  tool_calls: number;
  failed_tool_calls: number;
  repeated_calls: number;
};

/**
 * Row of GET /rollups — per-model request/token counts over a UTC day or
 * hour bucket. Model grain comes back verbatim so the client keeps pricing.
 */
export type ModelRollupRow = {
  user_id: string;
  /** "YYYY-MM-DD" (daily) or "YYYY-MM-DDTHH" (hourly). */
  bucket: string;
  model: string;
  model_requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
};

/** One GET /rollups answer: all-time totals plus the requested windows. */
export type RollupsSnapshot = {
  totals: {
    user_id: string;
    turns: number;
    tool_calls: number;
    failed_tool_calls: number;
    repeated_calls: number;
  }[];
  model_totals: ModelRollupRow[];
  daily: DailyRollupRow[];
  user_hourly: UserHourlyRollupRow[];
  model_daily: ModelRollupRow[];
  model_hourly: ModelRollupRow[];
};

/** One row of GET /admin/users — mirrors the Server's AdminUserRow. */
export type AdminUserRow = {
  name: string;
  email: string | null;
  disabled: boolean;
  is_dri: boolean;
  role: "admin" | "member";
  created_at: string;
  active_tokens: number;
  /** ADR 0011: whether password sign-in is available to this user. */
  password_set: boolean;
  team_id: string | null;
  team_name: string | null;
};

/** Row of GET /teams — the roster grouping for the leaderboard (decision 23). */
export type TeamInfo = {
  id: string;
  name: string;
  members: string[];
};

/** Row of GET /admin/teams — mirrors the Server's TeamRow. */
export type AdminTeamRow = {
  id: string;
  name: string;
  raw_retention_days: number | null;
  created_at: string;
  member_count: number;
};

/** Row of GET /admin/users/:name/tokens — plaintext secrets never come back. */
export type AdminTokenRow = {
  token_id: string;
  hint: string;
  /** Admin-given nickname; null when minted unlabeled. */
  label: string | null;
  created_at: string;
  revoked_at: string | null;
};

/** Payload of POST /admin/users/:name/tokens — the plaintext shows once. */
export type MintedToken = {
  token_id: string;
  hint: string;
  token: string;
  label: string | null;
};

/** Row of GET /admin/quarantine — one unparseable listener line, verbatim. */
export type QuarantineRow = {
  seq: number;
  agent: string;
  session_id: string;
  reason: string;
  line: string;
  occurred_at: string;
  created_at: string;
};

/**
 * Row of GET /admin/audit — one data mutation on the server (ADR 0007):
 * who acted, when, which action vocabulary term, on what target, and the
 * structured detail (before/after diffs, or the snapshot a hard delete
 * erased).
 */
export type AuditRow = {
  seq: number;
  occurred_at: string;
  actor_kind: "user" | "operator" | "system";
  actor_user: string | null;
  action: string;
  target: string;
  detail: Record<string, unknown>;
};

export type AdminHealth = {
  ok: boolean;
  sessions: number;
  events: number;
  last_event_at: string | null;
  quarantine_total: number;
  quarantine_24h: number;
  last_quarantine_at: string | null;
};

/** The five feedback kinds (ADR 0009), verbatim from the server. */
export type FeedbackKind =
  | "missing_content"
  | "wrong_data"
  | "compatibility"
  | "feature_suggestion"
  | "other";

/** Attachment metadata of a feedback row — bytes ride their own authed read. */
export type FeedbackAttachmentMeta = {
  sha256: string;
  filename: string;
  mime: string;
  size: number;
};

/**
 * One feedback row (ADR 0009): a stateless signal-channel entry, optionally
 * anchored to the session it was noticed on. Feature suggestions carry none.
 * Attachment metadata rides every read; the bytes never do.
 */
export type FeedbackRow = {
  feedback_id: number;
  filer_id: string;
  session_id: string | null;
  kind: FeedbackKind;
  body: string;
  created_at: string;
  attachments: FeedbackAttachmentMeta[];
};
