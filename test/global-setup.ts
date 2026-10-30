import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../src/db/migrate';

declare global {
  var __PG_CONTAINER__: StartedPostgreSqlContainer | undefined;
}

/** Uses TEST_DATABASE_URL when set; otherwise starts postgres:16. Migrations run either way. */
export default async function globalSetup(): Promise<void> {
  if (!process.env.TEST_DATABASE_URL) {
    const container = await new PostgreSqlContainer('postgres:16.10-alpine').start();
    globalThis.__PG_CONTAINER__ = container;
    process.env.TEST_DATABASE_URL = container.getConnectionUri();
  }
  await runMigrations(process.env.TEST_DATABASE_URL);
}
