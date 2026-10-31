import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../src/db/migrate';

declare global {
  var __PG_CONTAINER__: StartedPostgreSqlContainer | undefined;
}

/**
 * Starts a throwaway postgres:16 container (Docker is required) and runs the migrations. The
 * connection string is handed to the test workers through TEST_DB_URL.
 */
export default async function globalSetup(): Promise<void> {
  const container = await new PostgreSqlContainer('postgres:16.10-alpine').start();
  globalThis.__PG_CONTAINER__ = container;
  process.env.TEST_DB_URL = container.getConnectionUri();
  await runMigrations(process.env.TEST_DB_URL);
}
