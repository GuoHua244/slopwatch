import type { PgCtx } from "./db";
import type { Store } from "./types";

export const settingsMethods = (
  ctx: PgCtx,
): Pick<
  Store,
  "getSetting" | "setSetting" | "clearSetting" | "listSettings"
> => ({
  async getSetting(key) {
    const { rows } = await ctx.pool.query(
      "SELECT value FROM settings WHERE key = $1",
      [key],
    );
    return (rows[0]?.value as string | undefined) ?? null;
  },

  async setSetting(key, value) {
    await ctx.pool.query(
      "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
      [key, value],
    );
  },

  async clearSetting(key) {
    await ctx.pool.query("DELETE FROM settings WHERE key = $1", [key]);
  },

  async listSettings() {
    const { rows } = await ctx.pool.query("SELECT key, value FROM settings");
    const out: Record<string, string> = {};
    for (const row of rows) out[row.key as string] = row.value as string;
    return out;
  },
});
