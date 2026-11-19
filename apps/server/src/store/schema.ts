import type { PgCtx } from "./db";
import type { Store } from "./types";

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
-- Captured image bytes, content-addressed per session (sha256). Attachment
-- events never enter the events log — the turn/tool payload refs point here.
CREATE TABLE IF NOT EXISTS attachments (
  session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
  sha256     TEXT NOT NULL,
  origin     TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       BIGINT NOT NULL,
  data       BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, sha256)
);
CREATE INDEX IF NOT EXISTS events_received_at ON events (received_at);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS task_preview TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_input_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_output_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_cache_read_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_cache_write_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_event_at TIMESTAMPTZ;
-- v3 decision 31: deterministic waste counters, computed at ingest and
-- rebuilt from the events table by the recompute path.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS failed_tool_calls BIGINT NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS repeated_calls BIGINT NOT NULL DEFAULT 0;
-- Backfill once: a session's last activity is its newest event, falling back
-- to first_seen_at for rows that never carried events. Idempotent — the WHERE
-- keeps it off every row the ingest path already keeps fresh.
UPDATE sessions s
SET last_event_at = COALESCE(
  (SELECT max(e.received_at) FROM events e WHERE e.session_id = s.session_id),
  s.first_seen_at
)
WHERE s.last_event_at IS NULL;

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
-- Optional human label ("work laptop", "ci") telling a user's tokens apart;
-- the hint only carries the value's first chars.
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_dri BOOLEAN NOT NULL DEFAULT FALSE;
-- Role-based authorization: admins run the operator plane and read org-wide;
-- everyone else reads only their own rows. Existing rows default to member.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member';
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
-- v3 decision 31: the flat rollups carry the waste counters so the
-- leaderboard's rate can be windowed like every other column.
ALTER TABLE user_daily_rollup ADD COLUMN IF NOT EXISTS failed_tool_calls BIGINT NOT NULL DEFAULT 0;
ALTER TABLE user_daily_rollup ADD COLUMN IF NOT EXISTS repeated_calls BIGINT NOT NULL DEFAULT 0;
ALTER TABLE user_hourly_rollup ADD COLUMN IF NOT EXISTS failed_tool_calls BIGINT NOT NULL DEFAULT 0;
ALTER TABLE user_hourly_rollup ADD COLUMN IF NOT EXISTS repeated_calls BIGINT NOT NULL DEFAULT 0;
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
-- ADR 0007: append-only audit trail of every data mutation. Actors are
-- snapshotted as text (no FK) so deleting a user never erases their history.
CREATE TABLE IF NOT EXISTS audit_log (
  seq         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_kind  TEXT NOT NULL,
  actor_user  TEXT,
  action      TEXT NOT NULL,
  target      TEXT NOT NULL,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_action ON audit_log (action);
-- ADR 0008: per-user LLM credentials for server-side retrospectives. The key
-- is stored reversibly (the server must send it back to the provider) but is
-- never echoed by any read — masked hints only.
ALTER TABLE users ADD COLUMN IF NOT EXISTS llm_endpoint TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS llm_model TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS llm_api_key TEXT;
-- ADR 0008: one retrospective run per row — the resolved prompt snapshots
-- ride with the row so any report stays reproducible against exactly the
-- text that produced it.
CREATE TABLE IF NOT EXISTS retrospectives (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  angle           TEXT NOT NULL,
  supplement      TEXT,
  system_snapshot TEXT NOT NULL,
  prompt_snapshot TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  result          TEXT,
  model           TEXT,
  input_tokens      BIGINT,
  output_tokens     BIGINT,
  cache_read_tokens BIGINT,
  reasoning_tokens  BIGINT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS retrospectives_session ON retrospectives (session_id);
-- Streaming progress on a running row: the phase, the cumulative output
-- size, and the last write as the heartbeat the dashboard reads for hang
-- detection. Terminal writes clear all three.
ALTER TABLE retrospectives ADD COLUMN IF NOT EXISTS phase TEXT;
ALTER TABLE retrospectives ADD COLUMN IF NOT EXISTS output_chars BIGINT;
ALTER TABLE retrospectives ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;
ALTER TABLE retrospectives ADD COLUMN IF NOT EXISTS output_tail TEXT;
-- The per-user single-flight check reads only open rows.
CREATE INDEX IF NOT EXISTS retrospectives_user_open
  ON retrospectives (user_id) WHERE status IN ('pending', 'running');
-- Subagent sessions are found through their session:start payload's
-- parent_session_id — a partial expression index keeps the lookup targeted.
CREATE INDEX IF NOT EXISTS events_child_parent
  ON events ((payload->>'parent_session_id'))
  WHERE payload->>'parent_session_id' IS NOT NULL;
-- The rail nests subagent rows under their parent, so the link is lifted onto
-- the session row itself. Backfill once per boot: legacy children carry the
-- link only in their session:start payload; the WHERE keeps ingested rows off.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parent_session_id TEXT;
UPDATE sessions s
SET parent_session_id = c.pid
FROM (
  SELECT DISTINCT ON (session_id) session_id, payload->>'parent_session_id' AS pid
  FROM events
  WHERE payload->>'parent_session_id' IS NOT NULL
  ORDER BY session_id, event_seq
) c
WHERE s.session_id = c.session_id AND s.parent_session_id IS NULL;
-- Feedback (ADR 0009): a stateless signal channel filed from the dashboard.
-- Feature suggestions carry no session; defect feedback anchors the session
-- it was noticed on and cascades away with it.
CREATE TABLE IF NOT EXISTS feedback (
  feedback_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  filer_id     TEXT NOT NULL,
  session_id   TEXT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_created ON feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_session ON feedback (session_id);
CREATE INDEX IF NOT EXISTS feedback_kind ON feedback (kind);
-- Attachment bytes follow the session-attachment conventions: content-
-- addressed per feedback row, stored inline, cascading with their row.
CREATE TABLE IF NOT EXISTS feedback_attachments (
  feedback_id  BIGINT NOT NULL REFERENCES feedback (feedback_id) ON DELETE CASCADE,
  sha256       TEXT NOT NULL,
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         BIGINT NOT NULL,
  data         BYTEA NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (feedback_id, sha256)
);
-- Password sign-in (ADR 0011): the argon2id hash of the user's dashboard
-- password; NULL until they set one, so token and OIDC sign-ins keep working
-- untouched.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
-- One server-side session per password login: a revocable bearer stored
-- hashed like every other credential. Deleting the user cascades the
-- sessions away with them.
CREATE TABLE IF NOT EXISTS auth_sessions (
  session_id   UUID PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  user_name    TEXT NOT NULL REFERENCES users (name) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions (user_name);
`;

export const schemaMethods = ({ pool }: PgCtx): Pick<Store, "migrate"> => ({
  /** Create tables if missing. Idempotent. */
  async migrate() {
    await pool.query(DDL);
  },
});
