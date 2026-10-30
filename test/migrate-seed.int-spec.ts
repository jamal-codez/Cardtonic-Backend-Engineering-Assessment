import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { runMigrations } from '../src/db/migrate';
import { seedDatabase } from '../src/db/seed';
import { resetDb } from './helpers/reset-db';

const DATABASE_URL = (): string => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  return url;
};

describe('seed', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL(), max: 5 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('is idempotent: running it twice creates no duplicates and keeps ids', async () => {
    await resetDb(pool);
    const before = await pool.query<{ id: string }>('SELECT id FROM accounts ORDER BY id');

    await seedDatabase(drizzle(pool));
    await seedDatabase(drizzle(pool));

    const after = await pool.query<{ id: string }>('SELECT id FROM accounts ORDER BY id');
    expect(after.rows).toEqual(before.rows);
    const counts = await pool.query<{ currencies: number; external: number; fx_pool: number }>(
      `SELECT (SELECT count(*)::int FROM currencies) AS currencies,
              (SELECT count(*)::int FROM accounts WHERE kind = 'external') AS external,
              (SELECT count(*)::int FROM accounts WHERE kind = 'fx_pool') AS fx_pool`,
    );
    expect(counts.rows[0]).toEqual({ currencies: 5, external: 5, fx_pool: 5 });
  });

  it('seeds the currency registry with its fiat mapping', async () => {
    const { rows } = await pool.query<{ code: string; fiat_code: string; scale: number }>(
      'SELECT code, fiat_code, scale FROM currencies',
    );
    // Sorted in JS: the database collation decides ORDER BY, which differs between machines.
    const byCode = [...rows].sort((a, b) => (a.code < b.code ? -1 : 1));
    expect(byCode).toEqual([
      { code: 'EURx', fiat_code: 'EUR', scale: 6 },
      { code: 'USDx', fiat_code: 'USD', scale: 6 },
      { code: 'cGHS', fiat_code: 'GHS', scale: 6 },
      { code: 'cNGN', fiat_code: 'NGN', scale: 6 },
      { code: 'cXAF', fiat_code: 'XAF', scale: 6 },
    ]);
  });
});

describe('migrations', () => {
  it('can run twice at the same time on a fresh database thanks to the advisory lock', async () => {
    const admin = new Pool({ connectionString: DATABASE_URL(), max: 1 });
    const name = `migrate_race_${Date.now()}`;
    const url = new URL(DATABASE_URL());
    url.pathname = `/${name}`;
    await admin.query(`CREATE DATABASE ${name}`);
    try {
      await expect(
        Promise.all([runMigrations(url.toString()), runMigrations(url.toString())]),
      ).resolves.toBeDefined();

      const scratch = new Pool({ connectionString: url.toString(), max: 1 });
      try {
        const { rows } = await scratch.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
        );
        expect(rows[0]?.n).toBe(4);
      } finally {
        await scratch.end();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  });
});
