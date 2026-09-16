import { Pool } from "pg";
import { auditMethods } from "./audit";
import type { PgCtx } from "./db";
import { quarantineMethods } from "./quarantine";
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
  CommentRow,
  DailyRollupRow,
  HealthInfo,
  MeUsage,
  ModelRollupRow,
  QuarantineRow,
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
    ...auditMethods(ctx),
    ...quarantineMethods(ctx),
    ...settingsMethods(ctx),
    async close() {
      await pool.end();
    },
  };
};
