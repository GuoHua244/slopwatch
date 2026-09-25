import { Pool } from "pg";
import { auditMethods } from "./audit";
import type { PgCtx } from "./db";
import { feedbackMethods } from "./feedback";
import { quarantineMethods } from "./quarantine";
import { retrospectiveMethods } from "./retrospectives";
import { reviewMethods } from "./review";
import { rollupMethods } from "./rollups";
import { hashToken } from "./rows";
import { schemaMethods } from "./schema";
import { sessionMethods } from "./sessions";
import { settingsMethods } from "./settings";
import { teamMethods } from "./teams";
import { userMethods } from "./users-tokens";
import type { Store } from "./types";

export { NoSuchTeamError, TeamExistsError, UserExistsError } from "./errors";
export { hashToken } from "./rows";
export type {
  AdminTokenRow,
  AdminUserRow,
  AuditActor,
  AuditEntry,
  AuditRow,
  ChildSessionRollup,
  CommentRow,
  DailyRollupRow,
  FeedbackAttachmentMeta,
  FeedbackKind,
  FeedbackRow,
  HealthInfo,
  LlmConfig,
  MeUsage,
  ModelRollupRow,
  QuarantineRow,
  RetroRow,
  ReviewRow,
  Role,
  RollupsSnapshot,
  SessionRow,
  StoredEvent,
  TeamInfo,
  TeamRow,
  UserHourlyRollupRow,
} from "./types";
export type { Store } from "./types";

export const createPgStore = (databaseUrl: string): Store => {
  const pool = new Pool({ connectionString: databaseUrl });
  const ctx: PgCtx = { pool };
  return {
    ...schemaMethods(ctx),
    ...sessionMethods(ctx),
    ...rollupMethods(ctx),
    ...userMethods(ctx),
    ...teamMethods(ctx),
    ...reviewMethods(ctx),
    ...feedbackMethods(ctx),
    ...auditMethods(ctx),
    ...quarantineMethods(ctx),
    ...settingsMethods(ctx),
    ...retrospectiveMethods(ctx),
    async close() {
      await pool.end();
    },
  };
};
