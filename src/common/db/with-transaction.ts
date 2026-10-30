import type { Pool, PoolClient } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { AppError } from '../errors/app-error';
import { isRetryablePgError } from '../errors/pg-error-mapper';

export type Db = NodePgDatabase;

export interface TransactionOptions {
  /** Retries after the first attempt. Defaults to 3. */
  maxRetries?: number;
  /** Injected in tests so retries do not really wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests; returns a number in [0, 1). */
  random?: () => number;
}

const MIN_BACKOFF_MS = 50;
const MAX_BACKOFF_MS = 400;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function rollbackQuietly(client: PoolClient): Promise<boolean> {
  try {
    await client.query('ROLLBACK');
    return true;
  } catch {
    return false;
  }
}

async function attempt<T>(pool: Pool, fn: (tx: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let healthy = true;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '2s'`);
    await client.query(`SET LOCAL statement_timeout = '5s'`);
    const result = await fn(drizzle(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    healthy = await rollbackQuietly(client);
    throw error;
  } finally {
    // Passing true destroys a connection whose rollback failed instead of re-pooling it.
    client.release(healthy ? undefined : true);
  }
}

/**
 * Runs `fn` in one database transaction. The whole function is retried on deadlock,
 * serialization failure and lock timeout, so it must not perform network calls or other
 * non-repeatable side effects.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: Db) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let retry = 0; ; retry++) {
    try {
      return await attempt(pool, fn);
    } catch (error) {
      if (!isRetryablePgError(error)) throw error;
      if (retry >= maxRetries) {
        throw new AppError('RETRY_LATER', { retryAfterSeconds: 1, cause: error });
      }
      await sleep(MIN_BACKOFF_MS + Math.floor(random() * (MAX_BACKOFF_MS - MIN_BACKOFF_MS + 1)));
    }
  }
}
