import type pg from "pg";

export type Tx = pg.PoolClient;
/** Anything that can run a query: a pool or a transaction client. */
export type Queryable = Pick<pg.Pool, "query">;

export interface TxOptions {
  isolation?: "serializable" | "read committed";
  /** Total attempts including the first. Default 5. Only serialization failures and deadlocks retry. */
  attempts?: number;
}

const RETRYABLE = new Set(["40001", "40P01"]);

export function isRetryable(e: unknown): boolean {
  return typeof e === "object" && e !== null && RETRYABLE.has((e as { code?: string }).code ?? "");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `fn` in a transaction and commits. `fn` may run more than once under retry, so it must not
 * have side effects outside `tx`. Any other error rolls back and rethrows.
 */
export async function withTx<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const begin = opts.isolation === "serializable" ? "BEGIN ISOLATION LEVEL SERIALIZABLE" : "BEGIN ISOLATION LEVEL READ COMMITTED";
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    let release: boolean | Error = false;
    try {
      await client.query(begin);
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        release = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)); // discard the connection
      }
      if (attempt < attempts && isRetryable(e)) {
        await sleep(Math.min(5 * 2 ** attempt, 200) * (0.5 + Math.random()));
        continue;
      }
      throw e;
    } finally {
      client.release(release);
    }
  }
}
