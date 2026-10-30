import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';
import { loadConfig } from '../common/config/config';

/** Arbitrary constant; every process that migrates must use the same one. */
export const MIGRATION_LOCK_ID = 727_001;

const MIGRATIONS_FOLDER = join(__dirname, '..', '..', 'drizzle');

/**
 * Applies pending migrations under a session-level advisory lock, so concurrent starts
 * (several replicas booting at once) run them one at a time instead of racing.
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      // Best effort: a session lock is released when the connection closes anyway, and a failed
      // unlock must not hide the migration error.
      await client
        .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID])
        .catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  runMigrations(loadConfig().DATABASE_URL)
    .then(() => {
      console.log('Migrations applied');
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
