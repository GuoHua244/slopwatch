import type { NormalEvent } from "@slopwatch/events";
import type { OidcIdentity } from "../oidc";

export type SessionRow = {
  session_id: string;
  agent: string;
  user_id: string | null;
  /** Team snapshot from session creation (ADR 0004); never backfilled. */
  team_id: string | null;
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
};

export type StoredEvent = { event_seq: number; event: NormalEvent };

/** Authorization role: admins manage the operator plane and read org-wide. */
export type Role = "admin" | "member";

/** Row of GET /admin/users (decision 13). */
export type AdminUserRow = {
  name: string;
  email: string | null;
  disabled: boolean;
  is_dri: boolean;
  role: Role;
  created_at: string;
  active_tokens: number;
  /** The user's one team (v2 decision 23); null until the admin assigns one. */
  team_id: string | null;
  team_name: string | null;
};

/**
 * One signed-in user's lifetime footprint, all scoped to them regardless of
 * role — GET /me packs it so the profile page needs no second endpoint.
 */
export type MeUsage = {
  sessions: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  turns: number;
  tool_calls: number;
  /** Model-grain all-time token sums; cost stays a client-side estimate. */
  model_totals: ModelRollupRow[];
};

/** Row of GET /admin/teams (v2 decision 23). */
export type TeamRow = {
  id: string;
  name: string;
  /** Team-specific raw-payload retention override (v2 decision 24); days. */
  raw_retention_days: number | null;
  created_at: string;
  member_count: number;
};

/** GET /teams for authenticated readers: roster grouping for the leaderboard. */
export type TeamInfo = {
  id: string;
  name: string;
  members: string[];
};

/** Row of GET /admin/users/:name/tokens — the plaintext is never stored. */
export type AdminTokenRow = {
  token_id: string;
  hint: string;
  created_at: string;
  revoked_at: string | null;
};

/** The accountability marker (decision 10): one review per session, latest wins. */
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

export type HealthInfo = {
  sessions: number;
  events: number;
  last_event_at: string | null;
  /** Quarantine counters (v2 decision 21): schema drift must be visible. */
  quarantine_total: number;
  quarantine_24h: number;
  last_quarantine_at: string | null;
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
 * Who performed an audited action: a signed-in user, the operator bypass
 * token (no user identity to attribute), or the server itself (boot
 * provisioning, prune sweeps).
 */
export type AuditActor =
  | { kind: "user"; user: string }
  | { kind: "operator" }
  | { kind: "system" };

/** The write side of the audit log (ADR 0007): one mutation, one entry. */
export type AuditEntry = {
  actor: AuditActor;
  /** Vocabulary: "<resource>.<verb>" — user.create, session.delete, … */
  action: string;
  /** The affected thing, human-readable at action time (user/team name, session id, setting key). */
  target: string;
  /** Structured context — before/after diffs, or the snapshot a hard delete erases. */
  detail?: Record<string, unknown>;
};

/** Row of GET /admin/audit — mirrors AuditEntry plus identity and time. */
export type AuditRow = {
  seq: number;
  occurred_at: string;
  actor_kind: "user" | "operator" | "system";
  actor_user: string | null;
  action: string;
  target: string;
  detail: Record<string, unknown>;
};

/** Per-day turn/tool counts for one user (decision 18). */
export type DailyRollupRow = {
  user_id: string;
  /** UTC day, "YYYY-MM-DD". */
  day: string;
  turns: number;
  tool_calls: number;
};

/** Per-hour turn/tool counts for one user (v2 decision 27). */
export type UserHourlyRollupRow = {
  user_id: string;
  /** UTC hour, "YYYY-MM-DDTHH". */
  hour: string;
  turns: number;
  tool_calls: number;
};

/** Per-model request/token counts over a UTC day or hour bucket (decision 18). */
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

/**
 * One GET /rollups answer. Totals cover all history; the windowed arrays are
 * lower-bounded by the caller's cutoffs. Cost estimation stays client-side,
 * which is why model-grain rows come back verbatim instead of pre-priced.
 */
export type RollupsSnapshot = {
  totals: { user_id: string; turns: number; tool_calls: number }[];
  model_totals: ModelRollupRow[];
  daily: DailyRollupRow[];
  user_hourly: UserHourlyRollupRow[];
  model_daily: ModelRollupRow[];
  model_hourly: ModelRollupRow[];
};

export type Store = {
  /** Create tables if missing. Idempotent. */
  migrate(): Promise<void>;
  /** Persist a batch, assigning a per-session monotonic event_seq. */
  appendEvents(
    events: NormalEvent[],
    userId: string | null,
  ): Promise<{ accepted: number }>;
  /**
   * All sessions, newest first. `teamId` narrows to one team's snapshot
   * (the team-scoped DRI filter); the sentinel "unassigned" selects the
   * NULL-team bucket. `userId` narrows to one owner's sessions — the
   * read-plane hands it in for members so a user only ever sees their own.
   */
  listSessions(teamId?: string, userId?: string): Promise<SessionRow[]>;
  eventsSince(sessionId: string, sinceSeq: number): Promise<StoredEvent[]>;
  /** The session's owning user, or null when the session does not exist. */
  sessionOwner(sessionId: string): Promise<string | null>;
  /**
   * Decision 13: remove a whole session — normalized events, raw payloads,
   * and the row itself. The leak-remediation action. False when absent.
   */
  deleteSession(sessionId: string): Promise<boolean>;
  /**
   * Decision 11 + v2 decision 24: expire raw payloads past their effective
   * TTL — the owning user's current team override, else the default —
   * archiving each payload to the sink first when one is configured.
   * Archive failures leave the row for the next run.
   */
  pruneRaw(opts: {
    defaultDays: number;
    archive?: { putObject(key: string, body: string): Promise<void> };
  }): Promise<{ archived: number; pruned: number }>;
  /**
   * Rewrite each session's token columns with the full sum over its events.
   * The columns only accumulated events appended after they shipped, so
   * sessions captured before that undercount; idempotent, safe on a live DB.
   */
  backfillTokenTotals(): Promise<number>;
  /**
   * One-time maintenance: copy each zcode model_request's response text out
   * of its retained raw rollout record into the event payload (events
   * captured before response_text shipped). Idempotent; no-op when done.
   */
  backfillResponseText(): Promise<number>;
  /**
   * Decision 18: per-developer usage rollups, UTC-bucketed. `sinceDay` and
   * `sinceHour` ("YYYY-MM-DD" / "YYYY-MM-DDTHH") are inclusive lower bounds.
   * `teamId` narrows every window to one team's members ("unassigned" = users
   * with no team) via users.team_id; totals are scoped the same way. `userId`
   * narrows every window to one user — the read-plane hands it in for members.
   */
  listRollups(
    sinceDay: string,
    sinceHour: string,
    teamId?: string,
    userId?: string,
  ): Promise<RollupsSnapshot>;
  /** Full recompute of every rollup table from the events table. Rows written. */
  backfillRollups(): Promise<number>;
  /** Decision 13 admin plane. */
  createUser(name: string, email: string | null): Promise<AdminUserRow>;
  getUser(name: string): Promise<AdminUserRow | null>;
  listUsers(): Promise<AdminUserRow[]>;
  setUserDisabled(
    name: string,
    disabled: boolean,
  ): Promise<AdminUserRow | null>;
  deleteUser(name: string): Promise<boolean>;
  /** Mint a bearer token; the plaintext appears exactly once, in the return. */
  mintToken(
    userName: string,
  ): Promise<{ token_id: string; hint: string; token: string }>;
  listTokens(userName: string): Promise<AdminTokenRow[]>;
  revokeToken(tokenId: string): Promise<boolean>;
  /** Bearer token → user name; null for unknown, revoked, or disabled. */
  resolveTokenUser(token: string): Promise<string | null>;
  /**
   * ADR 0005: map a verified OIDC identity onto a user — the email claim
   * first, then preferred_username/subject, provisioning the row on first
   * sight. Null for disabled users and irreconcilable name collisions.
   */
  resolveOidcUser(identity: OidcIdentity): Promise<string | null>;
  /** Decision 10: mark a session reviewed (upsert). Null when the session is unknown. */
  markReviewed(
    sessionId: string,
    reviewerId: string,
  ): Promise<ReviewRow | null>;
  /** Decision 10: retract a review. False when no review (or session) exists. */
  unmarkReviewed(sessionId: string): Promise<boolean>;
  reviewFor(sessionId: string): Promise<ReviewRow | null>;
  /** Add a review note. Null when the session is unknown. */
  addComment(
    sessionId: string,
    turnId: string | null,
    authorId: string,
    body: string,
  ): Promise<CommentRow | null>;
  listComments(sessionId: string): Promise<CommentRow[]>;
  /**
   * Delete one review note — the author's own only. False when the note is
   * absent or written by someone else.
   */
  deleteComment(commentId: number, authorId: string): Promise<boolean>;
  /** Decision 10: the DRI role attribute. False for unknown users. */
  isDri(name: string): Promise<boolean>;
  setUserDri(name: string, isDri: boolean): Promise<AdminUserRow | null>;
  /** The user's authorization role; "member" for unknown users. */
  roleOf(name: string): Promise<Role>;
  /** Promote/demote between admin and member. Null when the user is unknown. */
  setUserRole(name: string, role: Role): Promise<AdminUserRow | null>;
  /**
   * Provision the row on first sight so env-token users become manageable
   * (team, DRI, role) without a manual create; a no-op when it exists.
   * True when this call created the row.
   */
  ensureUser(name: string): Promise<boolean>;
  /** Bootstrap: grant the admin role idempotently (SLOPWATCH_ADMINS). */
  ensureAdmin(name: string): Promise<void>;
  /** GET /me's usage block: one user's lifetime footprint. */
  ownUsage(name: string): Promise<MeUsage>;
  health(): Promise<HealthInfo>;
  /** v2 decision 21: recent quarantined lines, newest first. */
  listQuarantine(limit: number): Promise<QuarantineRow[]>;
  /** v2 decision 23: the team plane. */
  createTeam(name: string, rawRetentionDays: number | null): Promise<TeamRow>;
  listTeams(): Promise<TeamRow[]>;
  updateTeam(
    id: string,
    patch: { name?: string; raw_retention_days?: number | null },
  ): Promise<TeamRow | null>;
  deleteTeam(id: string): Promise<boolean>;
  /** Assign a user to a team; null when the user is unknown. */
  setUserTeam(
    name: string,
    teamId: string | null,
  ): Promise<AdminUserRow | null>;
  /** Roster for authenticated readers: teams with their member user names. */
  teamsWithMembers(): Promise<TeamInfo[]>;
  /** v2 decision 25: the operator settings plane. */
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  clearSetting(key: string): Promise<void>;
  listSettings(): Promise<Record<string, string>>;
  /** ADR 0007: append one audit entry. The only write the audit log has. */
  appendAudit(entry: AuditEntry): Promise<void>;
  /**
   * ADR 0007: the audit log, newest first. `kind` prefixes the action
   * ("user" matches user.*); `actor` substring-matches the acting user and
   * exactly matches the operator/system pseudo-actors. `total` respects the
   * filters for pagination.
   */
  listAudit(opts: {
    limit: number;
    offset: number;
    kind?: string;
    actor?: string;
  }): Promise<{ rows: AuditRow[]; total: number }>;
  /** One session row — the snapshot an audit trail captures before a hard delete. */
  getSession(sessionId: string): Promise<SessionRow | null>;
  /** One review note by id, regardless of author — the preview for its own audit entry. */
  getComment(commentId: number): Promise<CommentRow | null>;
  /** One team by id; null when unknown. */
  getTeam(id: string): Promise<TeamRow | null>;
  /** One token by id with its owning user; null when unknown. */
  getToken(
    tokenId: string,
  ): Promise<(AdminTokenRow & { user_name: string }) | null>;
  close(): Promise<void>;
};
