import type { Pool } from "pg";

/**
 * Anything with pg's query shape: the shared pool, or the checked-out client
 * inside a transaction. `rows` is any[] because callers cast per query.
 */
export type Queryable = {
  query: (
    sql: string,
    values?: unknown[],
  ) => Promise<{ rows: any[]; rowCount: number | null }>;
};

/** The one pg handle every store module shares. */
export type PgCtx = { pool: Pool };

/**
 * Run `fn` on one checked-out client inside a BEGIN/COMMIT bracket — the
 * transaction shape appendEvents, deleteSession, and backfillRollups share.
 * A thrown error rolls back and rethrows; the client is always released.
 */
export const withTransaction = async <T>(
  pool: Pool,
  fn: (client: Queryable) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
};
