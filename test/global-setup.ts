import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

declare global {
  var __PG_CONTAINER__: StartedPostgreSqlContainer | undefined;
}

/** Uses TEST_DATABASE_URL when set; otherwise starts postgres:16 (migrations arrive in phase 2). */
export default async function globalSetup(): Promise<void> {
  if (process.env.TEST_DATABASE_URL) return;
  const container = await new PostgreSqlContainer('postgres:16.10-alpine').start();
  globalThis.__PG_CONTAINER__ = container;
  process.env.TEST_DATABASE_URL = container.getConnectionUri();
}
