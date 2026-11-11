import type { Pool } from "pg";

/** One statement with numbered parameters (`$1`, `$2`), returning its rows. */
export type Queryable = { query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]> };

/**
 * The little of a Postgres client the store needs. The server gives it a
 * connection pool; tests give it an embedded Postgres, so the same SQL runs
 * in both.
 */
export type Sql = Queryable & {
  /** Runs `work` in one transaction: committed when it returns, rolled back when it throws. */
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export const pgSql = (pool: Pool): Sql => ({
  query: async <T>(text: string, params: readonly unknown[] = []) => (await pool.query(text, [...params])).rows as T[],
  transaction: async (work) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work({ query: async <T>(text: string, params: readonly unknown[] = []) => (await client.query(text, [...params])).rows as T[] });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },
  close: () => pool.end(),
});
