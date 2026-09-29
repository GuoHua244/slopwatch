import { createHash, randomBytes } from "node:crypto";
import type {
  AdminUserRow,
  AuditRow,
  CommentRow,
  FeedbackAttachmentMeta,
  FeedbackRow,
  ModelRollupRow,
  ReviewRow,
  Role,
  SessionRow,
  TeamRow,
} from "./types";

/** Postgres timestamptz → the store's one timestamp shape: an ISO string. */
export const iso = (value: unknown): string =>
  new Date(value as string).toISOString();

/** Bearer tokens are stored only as SHA-256 hashes (decision 6). */
export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export const mintTokenValue = (): {
  token: string;
  hash: string;
  hint: string;
} => {
  const token = `sw_${randomBytes(24).toString("hex")}`;
  return { token, hash: hashToken(token), hint: token.slice(0, 10) };
};

/** The full session-row SELECT list, shared by listSessions and getSession. */
export const SESSION_COLUMNS =
  "session_id, agent, user_id, team_id, first_seen_at, last_event_at, last_seq, title, task_preview, total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_write_tokens, parent_session_id";

export const asRole = (value: unknown): Role =>
  value === "admin" ? "admin" : "member";

export const pgUserRow = (r: Record<string, unknown>): AdminUserRow => ({
  name: r.name as string,
  email: (r.email as string | null) ?? null,
  disabled: r.disabled === true,
  is_dri: r.is_dri === true,
  role: asRole(r.role),
  created_at: iso(r.created_at),
  active_tokens: Number(r.active_tokens ?? 0),
  team_id: (r.team_id as string | null) ?? null,
  team_name: (r.team_name as string | null) ?? null,
});

export const pgTeamRow = (r: Record<string, unknown>): TeamRow => ({
  id: r.id as string,
  name: r.name as string,
  raw_retention_days:
    r.raw_retention_days === null || r.raw_retention_days === undefined
      ? null
      : Number(r.raw_retention_days),
  created_at: iso(r.created_at),
  member_count: Number(r.member_count ?? 0),
});

export const pgReviewRow = (r: Record<string, unknown>): ReviewRow => ({
  session_id: r.session_id as string,
  reviewer_id: r.reviewer_id as string,
  reviewed_at: iso(r.reviewed_at),
});

export const pgCommentRow = (r: Record<string, unknown>): CommentRow => ({
  comment_id: Number(r.comment_id),
  session_id: r.session_id as string,
  turn_id: (r.turn_id as string | null) ?? null,
  author_id: r.author_id as string,
  body: r.body as string,
  created_at: iso(r.created_at),
});

export const pgFeedbackRow = (r: Record<string, unknown>): FeedbackRow => ({
  feedback_id: Number(r.feedback_id),
  filer_id: r.filer_id as string,
  session_id: (r.session_id as string | null) ?? null,
  kind: r.kind as FeedbackRow["kind"],
  body: r.body as string,
  created_at: iso(r.created_at),
  attachments: (r.attachments as FeedbackAttachmentMeta[] | null) ?? [],
});

export const pgFeedbackAttachmentMeta = (
  r: Record<string, unknown>,
): FeedbackAttachmentMeta => ({
  sha256: r.sha256 as string,
  filename: r.filename as string,
  mime: r.mime as string,
  size: Number(r.size),
});

export const pgAuditRow = (r: Record<string, unknown>): AuditRow => ({
  seq: Number(r.seq),
  occurred_at: iso(r.occurred_at),
  actor_kind:
    r.actor_kind === "operator" || r.actor_kind === "system"
      ? r.actor_kind
      : "user",
  actor_user: (r.actor_user as string | null) ?? null,
  action: r.action as string,
  target: r.target as string,
  detail: (r.detail as Record<string, unknown> | null) ?? {},
});

export const pgSessionRow = (r: Record<string, unknown>): SessionRow => ({
  session_id: r.session_id as string,
  agent: r.agent as string,
  user_id: (r.user_id as string | null) ?? null,
  team_id: (r.team_id as string | null) ?? null,
  first_seen_at: iso(r.first_seen_at),
  last_event_at: r.last_event_at ? iso(r.last_event_at) : null,
  last_seq: Number(r.last_seq),
  title: (r.title as string | null) ?? null,
  task_preview: (r.task_preview as string | null) ?? null,
  total_input_tokens: Number(r.total_input_tokens),
  total_output_tokens: Number(r.total_output_tokens),
  total_cache_read_tokens: Number(r.total_cache_read_tokens),
  total_cache_write_tokens: Number(r.total_cache_write_tokens),
  parent_session_id: (r.parent_session_id as string | null) ?? null,
});

export const modelRollupRow = (r: Record<string, unknown>): ModelRollupRow => ({
  user_id: r.user_id as string,
  bucket: r.bucket as string,
  model: r.model as string,
  model_requests: Number(r.model_requests),
  input_tokens: Number(r.input_tokens),
  output_tokens: Number(r.output_tokens),
  cache_read_tokens: Number(r.cache_read_tokens),
  cache_write_tokens: Number(r.cache_write_tokens),
});
