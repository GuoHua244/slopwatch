import type { PgCtx } from "./db";
import { NoSuchTeamError, TeamExistsError } from "./errors";
import { pgTeamRow } from "./rows";
import { getUserRow } from "./users-tokens";
import type { Store, TeamRow } from "./types";

export const teamMethods = (
  ctx: PgCtx,
): Pick<
  Store,
  | "createTeam"
  | "listTeams"
  | "updateTeam"
  | "deleteTeam"
  | "setUserTeam"
  | "teamsWithMembers"
  | "getTeam"
> => {
  const { pool } = ctx;

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
      return getUserRow(ctx, name);
    },

    async getTeam(id) {
      return getTeamRow(id);
    },
  };
};
