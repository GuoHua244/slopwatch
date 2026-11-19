import { Pool } from "pg";
import { alertMethods } from "./alerts";
import { auditMethods } from "./audit";
import { authSessionMethods } from "./auth-sessions";
import { commitMethods } from "./commits";
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
import { weeklyMethods } from "./weekly";
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
  WeeklyData,
  WeeklyReportRow,
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
    ...alertMethods(ctx),
    ...commitMethods(ctx),
    ...weeklyMethods(ctx),
    ...quarantineMethods(ctx),
    ...settingsMethods(ctx),
    ...retrospectiveMethods(ctx),
    ...authSessionMethods(ctx),
    async close() {
      await pool.end();
    },
  };
};
