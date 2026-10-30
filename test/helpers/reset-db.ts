import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { seedDatabase } from '../../src/db/seed';

/**
 * Truncates every table except `currencies`, then reseeds. TRUNCATE bypasses the row-level
 * append-only triggers, which is fine for tests only.
 */
export async function resetDb(pool: Pool): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE idempotency_keys, wallet_activity, ledger_entries, transactions, accounts, wallets
     RESTART IDENTITY CASCADE`,
  );
  await seedDatabase(drizzle(pool));
}
