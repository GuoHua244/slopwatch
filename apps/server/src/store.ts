import { createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";
import type { NormalEvent, QuarantineEvent } from "@slopwatch/events";
import { rollupDeltas, type FlatDelta, type ModelDelta } from "./rollups";

export type SessionRow = {
  session_id: string;
  agent: string;
  user_id: string | null;
  /** Team snapshot from session creation (ADR 0004); never backfilled. */
  team_id: string | null;
  first_seen_at: string;
  last_seq: number;
  title: string | null;
  task_preview: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
};

export type StoredEvent = { event_seq: number; event: NormalEvent };

/** Row of GET /admin/users (decision 13). */
export type AdminUserRow = {
  name: string;
  email: string | null;
  disabled: boolean;
  is_dri: boolean;
  created_at: string;
  active_tokens: number;
  /** The user's one team (v2 decision 23); null until the admin assigns one. */
  team_id: string | null;
  team_name: string | null;
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

/** Thrown when a unique user name collides (HTTP 409). */
export class UserExistsError extends Error {
  constructor(name: string) {
    super(`user "${name}" already exists`);
    this.name = "UserExistsError";
  }
}

/** Thrown when a unique team name collides (HTTP 409). */
export class TeamExistsError extends Error {
  constructor(name: string) {
    super(`team "${name}" already exists`);
    this.name = "TeamExistsError";
  }
}

/** Thrown when a team id does not exist (HTTP 404). */
export class NoSuchTeamError extends Error {
  constructor() {
    super("no such team");
    this.name = "NoSuchTeamError";
  }
}

/** Bearer tokens are stored only as SHA-256 hashes (decision 6). */
export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const mintTokenValue = (): { token: string; hash: string; hint: string } => {
  const token = `sw_${randomBytes(24).toString("hex")}`;
  return { token, hash: hashToken(token), hint: token.slice(0, 10) };
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
   * NULL-team bucket.
   */
  listSessions(teamId?: string): Promise<SessionRow[]>;
  eventsSince(sessionId: string, sinceSeq: number): Promise<StoredEvent[]>;
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
   * Decision 18: per-developer usage rollups, UTC-bucketed. `sinceDay` and
   * `sinceHour` ("YYYY-MM-DD" / "YYYY-MM-DDTHH") are inclusive lower bounds.
   */
  listRollups(sinceDay: string, sinceHour: string): Promise<RollupsSnapshot>;
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
  /** Decision 10: the DRI role attribute. False for unknown users. */
  isDri(name: string): Promise<boolean>;
  setUserDri(name: string, isDri: boolean): Promise<AdminUserRow | null>;
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
  close(): Promise<void>;
};

const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  agent         TEXT NOT NULL,
  user_id       TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seq      BIGINT NOT NULL DEFAULT 0,
  title         TEXT,
  task_preview  TEXT,
  total_input_tokens       BIGINT NOT NULL DEFAULT 0,
  total_output_tokens      BIGINT NOT NULL DEFAULT 0,
  total_cache_read_tokens  BIGINT NOT NULL DEFAULT 0,
  total_cache_write_tokens BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  session_id  TEXT NOT NULL REFERENCES sessions (session_id),
  event_seq   BIGINT NOT NULL,
  agent       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  payload     JSONB NOT NULL,
  raw         JSONB,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, event_seq)
);
CREATE INDEX IF NOT EXISTS events_received_at ON events (received_at);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS task_preview TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_input_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_output_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_cache_read_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_cache_write_tokens BIGINT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS users (
  name       TEXT PRIMARY KEY,
  email      TEXT,
  disabled   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tokens (
  token_id   UUID PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  hint       TEXT NOT NULL,
  user_name  TEXT NOT NULL REFERENCES users (name) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_dri BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS session_reviews (
  session_id  TEXT PRIMARY KEY REFERENCES sessions (session_id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS review_comments (
  comment_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
  turn_id    TEXT,
  author_id  TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS review_comments_session ON review_comments (session_id);
CREATE TABLE IF NOT EXISTS user_daily_rollup (
  user_id    TEXT NOT NULL,
  day        TEXT NOT NULL,
  turns      BIGINT NOT NULL DEFAULT 0,
  tool_calls BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS user_hourly_rollup (
  user_id    TEXT NOT NULL,
  hour       TEXT NOT NULL,
  turns      BIGINT NOT NULL DEFAULT 0,
  tool_calls BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, hour)
);
CREATE TABLE IF NOT EXISTS model_daily_rollup (
  user_id            TEXT NOT NULL,
  day                TEXT NOT NULL,
  model              TEXT NOT NULL,
  model_requests     BIGINT NOT NULL DEFAULT 0,
  input_tokens       BIGINT NOT NULL DEFAULT 0,
  output_tokens      BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens  BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, model)
);
CREATE TABLE IF NOT EXISTS model_hourly_rollup (
  user_id            TEXT NOT NULL,
  hour               TEXT NOT NULL,
  model              TEXT NOT NULL,
  model_requests     BIGINT NOT NULL DEFAULT 0,
  input_tokens       BIGINT NOT NULL DEFAULT 0,
  output_tokens      BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens  BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, hour, model)
);
CREATE TABLE IF NOT EXISTS quarantine (
  seq         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent       TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  reason      TEXT NOT NULL,
  line        TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quarantine_created_at ON quarantine (created_at);
CREATE TABLE IF NOT EXISTS teams (
  id                 UUID PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  raw_retention_days INTEGER,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams (id) ON DELETE SET NULL;
-- ADR 0004: the session's team is a snapshot from creation time — no FK, so
-- a later team delete (or reorg) can never rewrite captured history.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS team_id UUID;
-- v2 decision 24: archive bookkeeping for the raw-payload cold store
ALTER TABLE events ADD COLUMN IF NOT EXISTS raw_archived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS archive_key TEXT;
-- v2 decision 25: operator-set configuration (the org webhook lives here)
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const USER_SELECT = `
  SELECT u.name, u.email, u.disabled, u.is_dri, u.created_at,
         u.team_id, t.name AS team_name,
         (SELECT COUNT(*) FROM tokens t2 WHERE t2.user_name = u.name AND t2.revoked_at IS NULL) AS active_tokens
  FROM users u LEFT JOIN teams t ON t.id = u.team_id`;

const pgUserRow = (r: Record<string, unknown>): AdminUserRow => ({
  name: r.name as string,
  email: (r.email as string | null) ?? null,
  disabled: r.disabled === true,
  is_dri: r.is_dri === true,
  created_at: new Date(r.created_at as string).toISOString(),
  active_tokens: Number(r.active_tokens ?? 0),
  team_id: (r.team_id as string | null) ?? null,
  team_name: (r.team_name as string | null) ?? null,
});

const pgTeamRow = (r: Record<string, unknown>): TeamRow => ({
  id: r.id as string,
  name: r.name as string,
  raw_retention_days:
    r.raw_retention_days === null || r.raw_retention_days === undefined
      ? null
      : Number(r.raw_retention_days),
  created_at: new Date(r.created_at as string).toISOString(),
  member_count: Number(r.member_count ?? 0),
});

const pgReviewRow = (r: Record<string, unknown>): ReviewRow => ({
  session_id: r.session_id as string,
  reviewer_id: r.reviewer_id as string,
  reviewed_at: new Date(r.reviewed_at as string).toISOString(),
});

const pgCommentRow = (r: Record<string, unknown>): CommentRow => ({
  comment_id: Number(r.comment_id),
  session_id: r.session_id as string,
  turn_id: (r.turn_id as string | null) ?? null,
  author_id: r.author_id as string,
  body: r.body as string,
  created_at: new Date(r.created_at as string).toISOString(),
});

const modelRollupRow = (r: Record<string, unknown>): ModelRollupRow => ({
  user_id: r.user_id as string,
  bucket: r.bucket as string,
  model: r.model as string,
  model_requests: Number(r.model_requests),
  input_tokens: Number(r.input_tokens),
  output_tokens: Number(r.output_tokens),
  cache_read_tokens: Number(r.cache_read_tokens),
  cache_write_tokens: Number(r.cache_write_tokens),
});

const DAY_BUCKET_SQL = `to_char((e.payload->>'occurred_at')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
const HOUR_BUCKET_SQL = `to_char((e.payload->>'occurred_at')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24')`;

/** Raw rows nulled per pruneRaw sweep — bounds the per-run transaction size. */
const PRUNE_RAW_BATCH = 200;

type Queryable = {
  query: (
    sql: string,
    values?: unknown[],
  ) => Promise<{ rowCount: number | null }>;
};

/**
 * Rebuild the rollup tables from the events table — the aggregate truth —
 * either for one user (after a session delete) or for everyone (backfill).
 * Bucketing mirrors rollups.ts: UTC day/hour of the event's occurred_at.
 */
const recomputeRollups = async (
  client: Queryable,
  userId?: string,
): Promise<number> => {
  const scoped = userId !== undefined;
  const args = scoped ? [userId] : [];
  const filter = scoped ? " AND s.user_id = $1" : "";
  for (const table of [
    "user_daily_rollup",
    "user_hourly_rollup",
    "model_daily_rollup",
    "model_hourly_rollup",
  ]) {
    await client.query(
      `DELETE FROM ${table}${scoped ? " WHERE user_id = $1" : ""}`,
      args,
    );
  }
  const from = `
    FROM events e
    JOIN sessions s ON s.session_id = e.session_id
    WHERE s.user_id IS NOT NULL${filter}`;
  const flatInsert = (table: string, bucketSql: string) => `
    INSERT INTO ${table} (user_id, ${
      table === "user_daily_rollup" ? "day" : "hour"
    }, turns, tool_calls)
    SELECT s.user_id,
           ${bucketSql},
           COUNT(*) FILTER (WHERE e.kind = 'turn' AND e.payload->>'event' = 'start'),
           COUNT(*) FILTER (WHERE e.kind = 'tool' AND e.payload->>'event' = 'call')
    ${from}
    GROUP BY s.user_id, 2
    HAVING COUNT(*) FILTER (WHERE e.kind = 'turn' AND e.payload->>'event' = 'start') > 0
        OR COUNT(*) FILTER (WHERE e.kind = 'tool' AND e.payload->>'event' = 'call') > 0`;
  const flat = await client.query(
    flatInsert("user_daily_rollup", DAY_BUCKET_SQL),
    args,
  );
  const flatHourly = await client.query(
    flatInsert("user_hourly_rollup", HOUR_BUCKET_SQL),
    args,
  );
  const modelInsert = (table: string, bucketSql: string) => `
    INSERT INTO ${table} (user_id, ${
      table === "model_daily_rollup" ? "day" : "hour"
    }, model, model_requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
    SELECT s.user_id,
           ${bucketSql},
           e.payload->>'model',
           COUNT(*),
           SUM(COALESCE((e.payload->'usage'->>'input_tokens')::bigint, 0)),
           SUM(COALESCE((e.payload->'usage'->>'output_tokens')::bigint, 0)),
           SUM(COALESCE((e.payload->'usage'->>'cache_read_tokens')::bigint, 0)),
           SUM(COALESCE((e.payload->'usage'->>'cache_write_tokens')::bigint, 0))
    ${from} AND e.kind = 'model_request'
    GROUP BY s.user_id, 2, 3`;
  const daily = await client.query(
    modelInsert("model_daily_rollup", DAY_BUCKET_SQL),
    args,
  );
  const hourly = await client.query(
    modelInsert("model_hourly_rollup", HOUR_BUCKET_SQL),
    args,
  );
  return (
    (flat.rowCount ?? 0) +
    (flatHourly.rowCount ?? 0) +
    (daily.rowCount ?? 0) +
    (hourly.rowCount ?? 0)
  );
};

export const createPgStore = (databaseUrl: string): Store => {
  const pool = new Pool({ connectionString: databaseUrl });

  const getTeamRow = async (id: string): Promise<TeamRow | null> => {
    const { rows } = await pool.query(
      `SELECT t.id, t.name, t.raw_retention_days, t.created_at,
              (SELECT COUNT(*) FROM users u WHERE u.team_id = t.id) AS member_count
      FROM teams t WHERE t.id = $1`,
      [id],
    );
    return rows[0] ? pgTeamRow(rows[0]) : null;
  };

  return {
    async migrate() {
      await pool.query(DDL);
    },

    async appendEvents(events, userId) {
      if (events.length === 0) return { accepted: 0 };
      // v2 decision 21: quarantine events bypass the event log entirely —
      // they record lines that could not be normalized, not session history.
      const normal = events.filter(
        (e): e is Exclude<NormalEvent, QuarantineEvent> =>
          e.kind !== "quarantine",
      );
      const quarantined = events.filter(
        (e): e is QuarantineEvent => e.kind === "quarantine",
      );
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const event of quarantined) {
          await client.query(
            "INSERT INTO quarantine (agent, session_id, reason, line, occurred_at) VALUES ($1, $2, $3, $4, $5)",
            [
              event.agent,
              event.session_id,
              event.reason,
              event.line,
              event.occurred_at,
            ],
          );
        }
        const bySession = new Map<string, NormalEvent[]>();
        for (const event of normal) {
          const group = bySession.get(event.session_id) ?? [];
          group.push(event);
          bySession.set(event.session_id, group);
        }
        // ADR 0004: the creating user's team AT INGEST TIME is snapshotted
        // onto a new session; reassignments never move captured history.
        let ingestTeamId: string | null = null;
        if (userId !== null) {
          const owned = await client.query(
            "SELECT team_id FROM users WHERE name = $1",
            [userId],
          );
          ingestTeamId = (owned.rows[0]?.team_id as string | null) ?? null;
        }
        for (const [sessionId, group] of bySession) {
          await client.query(
            "INSERT INTO sessions (session_id, agent, user_id, team_id) VALUES ($1, $2, $3, $4) ON CONFLICT (session_id) DO NOTHING",
            [sessionId, group[0]!.agent, userId, ingestTeamId],
          );
          // row lock on the session serializes concurrent writers
          const { rows } = await client.query(
            "UPDATE sessions SET last_seq = last_seq + $2 WHERE session_id = $1 RETURNING last_seq",
            [sessionId, group.length],
          );
          let seq = Number(rows[0]!.last_seq) - group.length;
          let dIn = 0;
          let dOut = 0;
          let dCacheRead = 0;
          let dCacheWrite = 0;
          for (const event of group) {
            seq += 1;
            const { raw, ...payload } = event;
            await client.query(
              "INSERT INTO events (session_id, event_seq, agent, kind, payload, raw) VALUES ($1, $2, $3, $4, $5, $6)",
              [
                sessionId,
                seq,
                event.agent,
                event.kind,
                JSON.stringify(payload),
                raw === undefined ? null : JSON.stringify(raw),
              ],
            );
            if (event.kind === "session" && event.event === "meta") {
              await client.query(
                "UPDATE sessions SET title = COALESCE($2, title), task_preview = COALESCE($3, task_preview) WHERE session_id = $1",
                [sessionId, event.title ?? null, event.task_preview ?? null],
              );
            }
            if (event.kind === "model_request" && event.usage) {
              dIn += event.usage.input_tokens ?? 0;
              dOut += event.usage.output_tokens ?? 0;
              dCacheRead += event.usage.cache_read_tokens ?? 0;
              dCacheWrite += event.usage.cache_write_tokens ?? 0;
            }
          }
          if (dIn || dOut || dCacheRead || dCacheWrite) {
            await client.query(
              "UPDATE sessions SET total_input_tokens = total_input_tokens + $2, total_output_tokens = total_output_tokens + $3, total_cache_read_tokens = total_cache_read_tokens + $4, total_cache_write_tokens = total_cache_write_tokens + $5 WHERE session_id = $1",
              [sessionId, dIn, dOut, dCacheRead, dCacheWrite],
            );
          }
        }
        // Decision 18: fold the batch into the usage rollups in the same
        // transaction, so the aggregates can never drift from the events.
        if (userId !== null && normal.length > 0) {
          const rollupUser: string = userId;
          const deltas = rollupDeltas(normal);
          const bumpFlatRollup = async (
            table: "user_daily_rollup" | "user_hourly_rollup",
            column: "day" | "hour",
            byBucket: Map<string, FlatDelta>,
          ) => {
            for (const [bucket, d] of byBucket) {
              if (d.turns === 0 && d.toolCalls === 0) continue;
              await client.query(
                `INSERT INTO ${table} (user_id, ${column}, turns, tool_calls)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (user_id, ${column}) DO UPDATE SET
                   turns = ${table}.turns + EXCLUDED.turns,
                   tool_calls = ${table}.tool_calls + EXCLUDED.tool_calls`,
                [rollupUser, bucket, d.turns, d.toolCalls],
              );
            }
          };
          await bumpFlatRollup("user_daily_rollup", "day", deltas.daily);
          await bumpFlatRollup("user_hourly_rollup", "hour", deltas.hourly);
          const upsertModelRollup = async (
            table: "model_daily_rollup" | "model_hourly_rollup",
            column: "day" | "hour",
            byModel: Map<string, Map<string, ModelDelta>>,
          ) => {
            for (const [bucket, models] of byModel) {
              for (const [model, d] of models) {
                await client.query(
                  `INSERT INTO ${table} (user_id, ${column}, model, model_requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                   ON CONFLICT (user_id, ${column}, model) DO UPDATE SET
                     model_requests = ${table}.model_requests + EXCLUDED.model_requests,
                     input_tokens = ${table}.input_tokens + EXCLUDED.input_tokens,
                     output_tokens = ${table}.output_tokens + EXCLUDED.output_tokens,
                     cache_read_tokens = ${table}.cache_read_tokens + EXCLUDED.cache_read_tokens,
                     cache_write_tokens = ${table}.cache_write_tokens + EXCLUDED.cache_write_tokens`,
                  [
                    rollupUser,
                    bucket,
                    model,
                    d.modelRequests,
                    d.inputTokens,
                    d.outputTokens,
                    d.cacheReadTokens,
                    d.cacheWriteTokens,
                  ],
                );
              }
            }
          };
          await upsertModelRollup(
            "model_daily_rollup",
            "day",
            deltas.modelDaily,
          );
          await upsertModelRollup(
            "model_hourly_rollup",
            "hour",
            deltas.modelHourly,
          );
        }
        await client.query("COMMIT");
        return { accepted: events.length };
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },

    async listSessions(teamId) {
      const filter =
        teamId === undefined
          ? ""
          : teamId === "unassigned"
            ? "WHERE team_id IS NULL"
            : "WHERE team_id = $1";
      const { rows } = await pool.query(
        `SELECT session_id, agent, user_id, team_id, first_seen_at, last_seq, title, task_preview, total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_write_tokens FROM sessions ${filter} ORDER BY first_seen_at DESC`,
        teamId !== undefined && teamId !== "unassigned" ? [teamId] : [],
      );
      return rows.map((r) => ({
        session_id: r.session_id as string,
        agent: r.agent as string,
        user_id: r.user_id as string | null,
        team_id: (r.team_id as string | null) ?? null,
        first_seen_at: new Date(r.first_seen_at as string).toISOString(),
        last_seq: Number(r.last_seq),
        title: (r.title as string | null) ?? null,
        task_preview: (r.task_preview as string | null) ?? null,
        total_input_tokens: Number(r.total_input_tokens),
        total_output_tokens: Number(r.total_output_tokens),
        total_cache_read_tokens: Number(r.total_cache_read_tokens),
        total_cache_write_tokens: Number(r.total_cache_write_tokens),
      }));
    },

    async eventsSince(sessionId, sinceSeq) {
      const { rows } = await pool.query(
        "SELECT event_seq, payload FROM events WHERE session_id = $1 AND event_seq > $2 ORDER BY event_seq ASC LIMIT 1000",
        [sessionId, sinceSeq],
      );
      return rows.map((r) => ({
        event_seq: Number(r.event_seq),
        event: r.payload as NormalEvent,
      }));
    },

    async pruneRaw({ defaultDays, archive }) {
      // effective TTL = the session's own team snapshot (ADR 0004: attribution
      // is frozen at ingest, so a later team move must not re-scope history),
      // falling back to the owner's current team for legacy sessions that
      // predate the snapshot, else the global default
      const candidates = await pool.query(
        `SELECT e.session_id, e.event_seq, e.agent, e.raw
        FROM events e
        JOIN sessions s ON s.session_id = e.session_id
        LEFT JOIN users u ON u.name = s.user_id
        LEFT JOIN teams t ON t.id = COALESCE(s.team_id, u.team_id)
        WHERE e.raw IS NOT NULL
          AND e.received_at < now() - make_interval(days => COALESCE(t.raw_retention_days, $1))
        LIMIT $2`,
        [defaultDays, PRUNE_RAW_BATCH],
      );
      let archived = 0;
      let pruned = 0;
      for (const row of candidates.rows) {
        const sessionId = row.session_id as string;
        const seq = Number(row.event_seq);
        const key = `raw/${row.agent}/${sessionId}/${seq}.json`;
        if (archive) {
          try {
            await archive.putObject(key, JSON.stringify(row.raw));
          } catch {
            continue; // keep the row; the next run retries the upload
          }
        }
        await pool.query(
          "UPDATE events SET raw = NULL, raw_archived = $3, archive_key = $4 WHERE session_id = $1 AND event_seq = $2",
          [
            sessionId,
            seq,
            archive !== undefined,
            archive !== undefined ? key : null,
          ],
        );
        if (archive !== undefined) archived += 1;
        pruned += 1;
      }
      return { archived, pruned };
    },

    async backfillTokenTotals() {
      const { rowCount } = await pool.query(`
        UPDATE sessions s SET
          total_input_tokens = COALESCE(a.i, 0),
          total_output_tokens = COALESCE(a.o, 0),
          total_cache_read_tokens = COALESCE(a.cr, 0),
          total_cache_write_tokens = COALESCE(a.cw, 0)
        FROM (
          SELECT session_id,
                 SUM((payload->'usage'->>'input_tokens')::bigint)      AS i,
                 SUM((payload->'usage'->>'output_tokens')::bigint)     AS o,
                 SUM((payload->'usage'->>'cache_read_tokens')::bigint)  AS cr,
                 SUM((payload->'usage'->>'cache_write_tokens')::bigint) AS cw
          FROM events
          WHERE kind = 'model_request'
          GROUP BY session_id
        ) a
        WHERE s.session_id = a.session_id
      `);
      return rowCount ?? 0;
    },

    async deleteSession(sessionId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const owner = await client.query(
          "SELECT user_id FROM sessions WHERE session_id = $1",
          [sessionId],
        );
        await client.query("DELETE FROM events WHERE session_id = $1", [
          sessionId,
        ]);
        const session = await client.query(
          "DELETE FROM sessions WHERE session_id = $1",
          [sessionId],
        );
        if ((session.rowCount ?? 0) > 0) {
          // Rollups keep summing the sessions that remain.
          const userId = owner.rows[0]?.user_id;
          if (typeof userId === "string")
            await recomputeRollups(client, userId);
        }
        await client.query("COMMIT");
        return (session.rowCount ?? 0) > 0;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },

    async listRollups(sinceDay, sinceHour) {
      const modelSelect =
        "user_id, day AS bucket, model, model_requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens";
      const totals = await pool.query(
        "SELECT user_id, SUM(turns) AS turns, SUM(tool_calls) AS tool_calls FROM user_daily_rollup GROUP BY user_id ORDER BY user_id",
      );
      const modelTotals = await pool.query(
        `SELECT user_id, model, SUM(model_requests) AS model_requests, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens FROM model_daily_rollup GROUP BY user_id, model ORDER BY user_id, model`,
      );
      const daily = await pool.query(
        "SELECT user_id, day, turns, tool_calls FROM user_daily_rollup WHERE day >= $1 ORDER BY user_id, day",
        [sinceDay],
      );
      const userHourly = await pool.query(
        "SELECT user_id, hour, turns, tool_calls FROM user_hourly_rollup WHERE hour >= $1 ORDER BY user_id, hour",
        [sinceHour],
      );
      const modelDaily = await pool.query(
        `SELECT ${modelSelect} FROM model_daily_rollup WHERE day >= $1 ORDER BY user_id, day, model`,
        [sinceDay],
      );
      const modelHourly = await pool.query(
        `SELECT ${modelSelect.replace("day AS bucket", "hour AS bucket")} FROM model_hourly_rollup WHERE hour >= $1 ORDER BY user_id, hour, model`,
        [sinceHour],
      );
      return {
        totals: totals.rows.map((r) => ({
          user_id: r.user_id as string,
          turns: Number(r.turns),
          tool_calls: Number(r.tool_calls),
        })),
        model_totals: modelTotals.rows.map((r) =>
          modelRollupRow({ ...r, bucket: "" }),
        ),
        daily: daily.rows.map((r) => ({
          user_id: r.user_id as string,
          day: r.day as string,
          turns: Number(r.turns),
          tool_calls: Number(r.tool_calls),
        })),
        model_daily: modelDaily.rows.map(modelRollupRow),
        model_hourly: modelHourly.rows.map(modelRollupRow),
        user_hourly: userHourly.rows.map((r) => ({
          user_id: r.user_id as string,
          hour: r.hour as string,
          turns: Number(r.turns),
          tool_calls: Number(r.tool_calls),
        })),
      };
    },

    async backfillRollups() {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const rows = await recomputeRollups(client);
        await client.query("COMMIT");
        return rows;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },

    async createUser(name, email) {
      try {
        const { rows } = await pool.query(
          "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING name, email, disabled, created_at",
          [name, email],
        );
        return pgUserRow({ ...rows[0]!, active_tokens: 0 });
      } catch (e) {
        if ((e as { code?: string }).code === "23505")
          throw new UserExistsError(name);
        throw e;
      }
    },

    async getUser(name) {
      const { rows } = await pool.query(`${USER_SELECT} WHERE u.name = $1`, [
        name,
      ]);
      return rows[0] ? pgUserRow(rows[0]) : null;
    },

    async listUsers() {
      const { rows } = await pool.query(
        `${USER_SELECT} ORDER BY u.created_at ASC`,
      );
      return rows.map((r) => pgUserRow(r));
    },

    async setUserDri(name, isDri) {
      await pool.query("UPDATE users SET is_dri = $2 WHERE name = $1", [
        name,
        isDri,
      ]);
      return this.getUser(name);
    },

    async setUserDisabled(name, disabled) {
      await pool.query("UPDATE users SET disabled = $2 WHERE name = $1", [
        name,
        disabled,
      ]);
      return this.getUser(name);
    },

    async setUserTeam(name, teamId) {
      if (teamId !== null) {
        const team = await pool.query("SELECT id FROM teams WHERE id = $1", [
          teamId,
        ]);
        if (team.rowCount === 0) throw new NoSuchTeamError();
      }
      const updated = await pool.query(
        "UPDATE users SET team_id = $2 WHERE name = $1",
        [name, teamId],
      );
      if ((updated.rowCount ?? 0) === 0) return null;
      return this.getUser(name);
    },

    async createTeam(name, rawRetentionDays) {
      const id = crypto.randomUUID();
      try {
        const { rows } = await pool.query(
          "INSERT INTO teams (id, name, raw_retention_days) VALUES ($1, $2, $3) RETURNING id, name, raw_retention_days, created_at",
          [id, name, rawRetentionDays],
        );
        return pgTeamRow({ ...rows[0]!, member_count: 0 });
      } catch (e) {
        if ((e as { code?: string }).code === "23505")
          throw new TeamExistsError(name);
        throw e;
      }
    },

    async listTeams() {
      const { rows } = await pool.query(`
        SELECT t.id, t.name, t.raw_retention_days, t.created_at,
               (SELECT COUNT(*) FROM users u WHERE u.team_id = t.id) AS member_count
        FROM teams t ORDER BY t.created_at ASC
      `);
      return rows.map((r) => pgTeamRow(r));
    },

    async updateTeam(id, patch) {
      const sets: string[] = [];
      const args: unknown[] = [];
      if (patch.name !== undefined) {
        args.push(patch.name);
        sets.push(`name = $${args.length}`);
      }
      if (patch.raw_retention_days !== undefined) {
        args.push(patch.raw_retention_days);
        sets.push(`raw_retention_days = $${args.length}`);
      }
      if (sets.length === 0) return getTeamRow(id);
      args.push(id);
      const { rows } = await pool.query(
        `UPDATE teams SET ${sets.join(", ")} WHERE id = $${args.length} RETURNING id`,
        args,
      );
      if (rows.length === 0) return null;
      return getTeamRow(id);
    },

    async deleteTeam(id) {
      const { rowCount } = await pool.query("DELETE FROM teams WHERE id = $1", [
        id,
      ]);
      return (rowCount ?? 0) > 0;
    },

    async teamsWithMembers() {
      const { rows } = await pool.query(`
        SELECT t.id, t.name, COALESCE(array_agg(u.name) FILTER (WHERE u.name IS NOT NULL), '{}') AS members
        FROM teams t LEFT JOIN users u ON u.team_id = t.id
        GROUP BY t.id, t.name ORDER BY t.created_at ASC
      `);
      return rows.map((r) => ({
        id: r.id as string,
        name: r.name as string,
        members: (r.members as string[]) ?? [],
      }));
    },

    async deleteUser(name) {
      const { rowCount } = await pool.query(
        "DELETE FROM users WHERE name = $1",
        [name],
      );
      return (rowCount ?? 0) > 0;
    },

    async mintToken(userName) {
      const { token, hash, hint } = mintTokenValue();
      const { rows } = await pool.query(
        "INSERT INTO tokens (token_id, token_hash, hint, user_name) VALUES ($1, $2, $3, $4) RETURNING token_id",
        [crypto.randomUUID(), hash, hint, userName],
      );
      return { token_id: rows[0]!.token_id as string, hint, token };
    },

    async listTokens(userName) {
      const { rows } = await pool.query(
        "SELECT token_id, hint, created_at, revoked_at FROM tokens WHERE user_name = $1 ORDER BY created_at ASC",
        [userName],
      );
      return rows.map((r) => ({
        token_id: r.token_id as string,
        hint: r.hint as string,
        created_at: new Date(r.created_at as string).toISOString(),
        revoked_at: r.revoked_at
          ? new Date(r.revoked_at as string).toISOString()
          : null,
      }));
    },

    async revokeToken(tokenId) {
      const { rowCount } = await pool.query(
        "UPDATE tokens SET revoked_at = now() WHERE token_id = $1 AND revoked_at IS NULL",
        [tokenId],
      );
      return (rowCount ?? 0) > 0;
    },

    async resolveTokenUser(token) {
      const { rows } = await pool.query(
        `SELECT t.user_name FROM tokens t
         JOIN users u ON u.name = t.user_name
         WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND NOT u.disabled`,
        [hashToken(token)],
      );
      return (rows[0]?.user_name as string | undefined) ?? null;
    },

    async markReviewed(sessionId, reviewerId) {
      try {
        const { rows } = await pool.query(
          `INSERT INTO session_reviews (session_id, reviewer_id) VALUES ($1, $2)
         ON CONFLICT (session_id) DO UPDATE
           SET reviewer_id = EXCLUDED.reviewer_id, reviewed_at = now()
         RETURNING session_id, reviewer_id, reviewed_at`,
          [sessionId, reviewerId],
        );
        return pgReviewRow(rows[0]!);
      } catch (e) {
        if ((e as { code?: string }).code === "23503") return null; // no such session
        throw e;
      }
    },

    async unmarkReviewed(sessionId) {
      const { rowCount } = await pool.query(
        "DELETE FROM session_reviews WHERE session_id = $1",
        [sessionId],
      );
      return (rowCount ?? 0) > 0;
    },

    async reviewFor(sessionId) {
      const { rows } = await pool.query(
        "SELECT session_id, reviewer_id, reviewed_at FROM session_reviews WHERE session_id = $1",
        [sessionId],
      );
      return rows[0] ? pgReviewRow(rows[0]) : null;
    },

    async addComment(sessionId, turnId, authorId, body) {
      try {
        const { rows } = await pool.query(
          "INSERT INTO review_comments (session_id, turn_id, author_id, body) VALUES ($1, $2, $3, $4) RETURNING comment_id, session_id, turn_id, author_id, body, created_at",
          [sessionId, turnId, authorId, body],
        );
        return pgCommentRow(rows[0]!);
      } catch (e) {
        if ((e as { code?: string }).code === "23503") return null; // no such session
        throw e;
      }
    },

    async listComments(sessionId) {
      const { rows } = await pool.query(
        "SELECT comment_id, session_id, turn_id, author_id, body, created_at FROM review_comments WHERE session_id = $1 ORDER BY created_at ASC, comment_id ASC",
        [sessionId],
      );
      return rows.map((r) => pgCommentRow(r));
    },

    async isDri(name) {
      const { rows } = await pool.query(
        "SELECT is_dri FROM users WHERE name = $1",
        [name],
      );
      return rows[0]?.is_dri === true;
    },

    async health() {
      const { rows } = await pool.query(
        `SELECT (SELECT COUNT(*) FROM sessions) AS sessions,
                (SELECT COUNT(*) FROM events) AS events,
                (SELECT MAX(received_at) FROM events) AS last_event_at,
                (SELECT COUNT(*) FROM quarantine) AS quarantine_total,
                (SELECT COUNT(*) FROM quarantine WHERE created_at > now() - interval '24 hours') AS quarantine_24h,
                (SELECT MAX(created_at) FROM quarantine) AS last_quarantine_at`,
      );
      return {
        sessions: Number(rows[0]!.sessions),
        events: Number(rows[0]!.events),
        last_event_at: rows[0]!.last_event_at
          ? new Date(rows[0]!.last_event_at as string).toISOString()
          : null,
        quarantine_total: Number(rows[0]!.quarantine_total),
        quarantine_24h: Number(rows[0]!.quarantine_24h),
        last_quarantine_at: rows[0]!.last_quarantine_at
          ? new Date(rows[0]!.last_quarantine_at as string).toISOString()
          : null,
      };
    },

    async listQuarantine(limit) {
      const { rows } = await pool.query(
        "SELECT seq, agent, session_id, reason, line, occurred_at, created_at FROM quarantine ORDER BY seq DESC LIMIT $1",
        [limit],
      );
      return rows.map((r) => ({
        seq: Number(r.seq),
        agent: r.agent as string,
        session_id: r.session_id as string,
        reason: r.reason as string,
        line: r.line as string,
        occurred_at: new Date(r.occurred_at as string).toISOString(),
        created_at: new Date(r.created_at as string).toISOString(),
      }));
    },

    async getSetting(key) {
      const { rows } = await pool.query(
        "SELECT value FROM settings WHERE key = $1",
        [key],
      );
      return (rows[0]?.value as string | undefined) ?? null;
    },

    async setSetting(key, value) {
      await pool.query(
        "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        [key, value],
      );
    },

    async clearSetting(key) {
      await pool.query("DELETE FROM settings WHERE key = $1", [key]);
    },

    async listSettings() {
      const { rows } = await pool.query("SELECT key, value FROM settings");
      const out: Record<string, string> = {};
      for (const row of rows) out[row.key as string] = row.value as string;
      return out;
    },

    async close() {
      await pool.end();
    },
  };
};
