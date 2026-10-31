import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RECON_LOCK_ID } from '../src/ledger/reconciliation.service';
import { resetDb } from './helpers/reset-db';
import { createUserAccount, createWallet } from './helpers/factories';

const ROOT = resolve(__dirname, '..');

function runCli() {
  const result = spawnSync(
    process.execPath,
    ['--require', 'ts-node/register/transpile-only', 'src/ledger/reconcile-cli.ts'],
    {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: process.env.TEST_DB_URL, NODE_ENV: 'test' },
      encoding: 'utf8',
      timeout: 90_000,
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('yarn reconcile (CLI)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.TEST_DB_URL, max: 3 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDb(pool);
  });

  it('is wired to the reconcile script in package.json', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../package.json') as { scripts: Record<string, string> };
    expect(pkg.scripts['reconcile']).toContain('src/ledger/reconcile-cli.ts');
  });

  it('exits 0 and prints the run as JSON on a clean database', () => {
    const { status, stdout, stderr } = runCli();

    expect({ status, stderr: status === 0 ? '' : stderr }).toEqual({ status: 0, stderr: '' });
    const run = JSON.parse(stdout) as { ok: boolean; mode: string; drift: unknown[] };
    expect(run).toMatchObject({ ok: true, mode: 'full', drift: [] });
  });

  it('exits 1 after injected drift, and names the account and delta', async () => {
    const wallet = await createWallet(pool);
    const account = await createUserAccount(pool, wallet, 'cNGN', 0n);
    await pool.query('UPDATE accounts SET balance = balance + 1 WHERE id = $1', [account]);

    const { status, stdout } = runCli();

    expect(status).toBe(1);
    const run = JSON.parse(stdout) as {
      ok: boolean;
      drift: { account_id: string; delta: string }[];
    };
    expect(run.ok).toBe(false);
    expect(run.drift).toEqual([
      expect.objectContaining({ account_id: account, delta: '0.000001' }),
    ]);
    // The CLI never repaired it.
    const { rows } = await pool.query<{ balance: string }>(
      'SELECT balance::text FROM accounts WHERE id = $1',
      [account],
    );
    expect(rows[0]?.balance).toBe('1');
  });

  it('exits 2 and prints { skipped: true } when another run holds the lock', async () => {
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [RECON_LOCK_ID]);
      const { status, stdout } = runCli();
      expect(status).toBe(2);
      expect(JSON.parse(stdout)).toEqual({ skipped: true });
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [RECON_LOCK_ID]);
      holder.release();
    }
  });
});
