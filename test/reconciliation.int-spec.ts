import { drizzle } from 'drizzle-orm/node-postgres';
import { v7 as uuidv7 } from 'uuid';
import type { Client, Pool } from 'pg';
import { APP_CONFIG, type AppConfig } from '../src/common/config/config';
import { ReconciliationService, RECON_LOCK_ID } from '../src/ledger/reconciliation.service';
import { isSkipped, type ReconciliationRun } from '../src/ledger/reconciliation.types';
import { createTestApp, type TestApp } from './helpers/create-test-app';

describe('reconciliation', () => {
  let t: TestApp;
  let service: ReconciliationService;
  let freezing: ReconciliationService;
  let config: AppConfig;
  let a: string;
  let b: string;
  let keyCounter = 0;

  beforeAll(async () => {
    t = await createTestApp();
    config = t.app.get<AppConfig>(APP_CONFIG);
    service = t.app.get(ReconciliationService);
    freezing = new ReconciliationService(t.pool, { ...config, RECON_FREEZE_ON_DRIFT: true });
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await t.reset();
    a = (await t.agent.post('/v1/wallets').send({ email: 'ra@example.com' }).expect(201)).body.id;
    b = (await t.agent.post('/v1/wallets').send({ email: 'rb@example.com' }).expect(201)).body.id;
  });

  const nextKey = () => `recon-key-${++keyCounter}`;

  const deposit = (walletId: string, currency: string, amount: string) =>
    t.agent
      .post(`/v1/wallets/${walletId}/deposits`)
      .set('Idempotency-Key', nextKey())
      .send({ currency, amount })
      .expect(201);

  const transfer = (from: string, to: string, currency: string, amount: string, dest?: string) =>
    t.agent
      .post(`/v1/wallets/${from}/transfers`)
      .set('Idempotency-Key', nextKey())
      .send({
        to_wallet_id: to,
        source_currency: currency,
        ...(dest ? { destination_currency: dest } : {}),
        amount,
      });

  async function runOf(
    svc: ReconciliationService,
    mode: 'full' | 'incremental',
  ): Promise<ReconciliationRun> {
    const result = await svc.run(mode);
    if (isSkipped(result)) throw new Error('run was unexpectedly skipped');
    return result;
  }

  const accountId = async (walletId: string, currency: string): Promise<string> => {
    const { rows } = await t.pool.query<{ id: string }>(
      `SELECT id FROM accounts WHERE wallet_id = $1 AND currency = $2`,
      [walletId, currency],
    );
    return rows[0]?.id as string;
  };

  async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
    const { rows } = await t.pool.query<{ v: T }>(sql, params);
    return rows[0]?.v as T;
  }

  /**
   * A balanced deposit from a day ago, written directly (database triggers bypassed for this
   * session): old entries, old transaction and a backdated account row. Entries are append-only,
   * so this is the only way to get history that is really outside an incremental window.
   */
  async function oldDeposit(walletId: string, currency: string, amount: bigint): Promise<void> {
    const account = await accountId(walletId, currency);
    const external = await t.ledger.getSystemAccountId('external', currency);
    const transactionId = uuidv7();
    const client = await t.pool.connect();
    try {
      await client.query('SET session_replication_role = replica');
      await client.query(
        `INSERT INTO transactions (id, type, initiator_wallet_id, source_currency, source_amount,
                                   dest_currency, dest_amount, created_at)
         VALUES ($1, 'deposit', $2, $3, $4, $3, $4, now() - interval '1 day')`,
        [transactionId, walletId, currency, amount.toString()],
      );
      await client.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, currency, amount, created_at)
         VALUES ($1, $2, $3, $4, now() - interval '1 day'),
                ($1, $5, $3, $6, now() - interval '1 day')`,
        [transactionId, account, currency, amount.toString(), external, (-amount).toString()],
      );
      await client.query(
        `UPDATE accounts SET balance = balance + $2::bigint, updated_at = now() - interval '1 day'
          WHERE id = $1`,
        [account, amount.toString()],
      );
    } finally {
      await client.query('RESET session_replication_role');
      client.release();
    }
  }

  /** Holds the reconciliation advisory lock on its own connection, as another replica would. */
  async function holdLock(): Promise<{ release: () => Promise<void> }> {
    const client: Client = await t.pool.connect().then((c) => c as unknown as Client);
    await client.query('SELECT pg_advisory_lock($1)', [RECON_LOCK_ID]);
    return {
      release: async () => {
        await client.query('SELECT pg_advisory_unlock($1)', [RECON_LOCK_ID]);
        (client as unknown as { release: () => void }).release();
      },
    };
  }

  describe('a healthy ledger', () => {
    it('is ok on an empty ledger', async () => {
      const run = await runOf(service, 'full');
      expect(run).toMatchObject({
        ok: true,
        mode: 'full',
        drift: [],
        unbalancedTx: [],
        windowFrom: null,
      });
      expect(run.accountsChecked).toBe(10);
    });

    it('is ok after deposits, swaps and transfers, and records the run', async () => {
      await deposit(a, 'cNGN', '3000');
      await t.agent
        .post(`/v1/wallets/${a}/swaps`)
        .set('Idempotency-Key', nextKey())
        .send({ from_currency: 'cNGN', to_currency: 'USDx', amount: '1000' })
        .expect(201);
      await transfer(a, b, 'cNGN', '500').then((r) => expect(r.status).toBe(201));
      await transfer(a, b, 'cNGN', '700', 'cGHS').then((r) => expect(r.status).toBe(201));

      const run = await runOf(service, 'full');

      expect(run.ok).toBe(true);
      expect(run.drift).toEqual([]);
      expect(run.unbalancedTx).toEqual([]);
      expect(Object.values(run.currencyNet).every((net) => net === '0.000000')).toBe(true);
      expect(Object.keys(run.currencyNet).sort()).toEqual(['EURx', 'USDx', 'cGHS', 'cNGN', 'cXAF']);
      expect(await scalar<number>('SELECT count(*)::int AS v FROM reconciliation_runs')).toBe(1);
      expect(
        await scalar<boolean>('SELECT ok AS v FROM reconciliation_runs WHERE id = $1', [run.id]),
      ).toBe(true);
    });
  });

  describe('detects drift and never repairs it', () => {
    it('reports an account whose balance is 1 minor unit too high, and leaves it alone', async () => {
      await deposit(a, 'cNGN', '100');
      const account = await accountId(a, 'cNGN');
      await t.pool.query('UPDATE accounts SET balance = balance + 1 WHERE id = $1', [account]);

      const run = await runOf(service, 'full');

      expect(run.ok).toBe(false);
      expect(run.drift).toEqual([
        {
          account_id: account,
          wallet_id: a,
          currency: 'cNGN',
          stored: '100.000001',
          expected: '100.000000',
          delta: '0.000001',
        },
      ]);
      // Detect, never repair: the wrong balance is still wrong, and no entry was added.
      expect(
        await scalar<string>('SELECT balance::text AS v FROM accounts WHERE id = $1', [account]),
      ).toBe('100000001');
      expect(await scalar<number>('SELECT count(*)::int AS v FROM ledger_entries')).toBe(2);
      expect(
        await scalar<boolean>('SELECT ok AS v FROM reconciliation_runs WHERE id = $1', [run.id]),
      ).toBe(false);
    });

    it('reports a balance that is too low as a negative delta', async () => {
      await deposit(a, 'cNGN', '100');
      const account = await accountId(a, 'cNGN');
      await t.pool.query('UPDATE accounts SET balance = balance - 1 WHERE id = $1', [account]);

      const run = await runOf(service, 'full');

      expect(run.drift).toHaveLength(1);
      expect(run.drift[0]?.delta).toBe('-0.000001');
    });

    it('reports every drifting account, not just the first', async () => {
      await deposit(a, 'cNGN', '100');
      await deposit(b, 'USDx', '5');
      await t.pool.query(`UPDATE accounts SET balance = balance + 7 WHERE id = ANY($1::uuid[])`, [
        [await accountId(a, 'cNGN'), await accountId(b, 'USDx')],
      ]);
      const run = await runOf(service, 'full');
      expect(run.drift.map((d) => d.delta)).toEqual(['0.000007', '0.000007']);
    });

    it('does not freeze anything by default', async () => {
      await deposit(a, 'cNGN', '100');
      await t.pool.query('UPDATE accounts SET balance = balance + 1 WHERE id = $1', [
        await accountId(a, 'cNGN'),
      ]);
      await runOf(service, 'full');
      expect(await scalar<string>('SELECT status AS v FROM wallets WHERE id = $1', [a])).toBe(
        'active',
      );
    });

    it('with RECON_FREEZE_ON_DRIFT it freezes only the affected wallet, whose next debit is WALLET_FROZEN', async () => {
      await deposit(a, 'cNGN', '100');
      await deposit(b, 'cNGN', '100');
      await t.pool.query('UPDATE accounts SET balance = balance + 1 WHERE id = $1', [
        await accountId(a, 'cNGN'),
      ]);

      const run = await runOf(freezing, 'full');

      expect(run.ok).toBe(false);
      expect(await scalar<string>('SELECT status AS v FROM wallets WHERE id = $1', [a])).toBe(
        'frozen',
      );
      expect(await scalar<string>('SELECT status AS v FROM wallets WHERE id = $1', [b])).toBe(
        'active',
      );

      const debit = await transfer(a, b, 'cNGN', '10').then((r) => r);
      expect(debit.status).toBe(422);
      expect(debit.body).toMatchObject({ code: 'WALLET_FROZEN' });
      // The frozen wallet can still receive.
      const credit = await transfer(b, a, 'cNGN', '10');
      expect(credit.status).toBe(201);
    });

    it('detects an entry imbalance and a transaction with too few entries, with balances untouched', async () => {
      await deposit(a, 'cNGN', '100');
      const account = await accountId(a, 'cNGN');
      // Bypass the database triggers (superuser, this session only) to plant a broken transaction:
      // one entry of +5 on a user account, with no balancing entry and no balance update.
      const client = await t.pool.connect();
      try {
        await client.query('SET session_replication_role = replica');
        await client.query(
          `INSERT INTO transactions (id, type, initiator_wallet_id, source_currency, source_amount,
                                     dest_currency, dest_amount)
           VALUES ('00000000-0000-7000-8000-00000000dead', 'deposit', $1, 'cNGN', 5, 'cNGN', 5)`,
          [a],
        );
        await client.query(
          `INSERT INTO ledger_entries (transaction_id, account_id, currency, amount)
           VALUES ('00000000-0000-7000-8000-00000000dead', $1, 'cNGN', 5)`,
          [account],
        );
      } finally {
        await client.query('RESET session_replication_role');
        client.release();
      }

      const run = await runOf(service, 'full');

      expect(run.ok).toBe(false);
      expect(run.currencyNet['cNGN']).toBe('0.000005');
      expect(run.unbalancedTx).toEqual([
        { transaction_id: '00000000-0000-7000-8000-00000000dead', entries: 1 },
      ]);
      expect(run.drift[0]).toMatchObject({ account_id: account, delta: '-0.000005' });
      expect(
        await scalar<string>('SELECT balance::text AS v FROM accounts WHERE id = $1', [account]),
      ).toBe('100000000');
    });
  });

  describe('snapshot consistency', () => {
    it('reports no false drift while 50 transfers are in flight', async () => {
      await deposit(a, 'cNGN', '5000');
      await deposit(b, 'cNGN', '5000');

      const transfers = Promise.all(
        Array.from({ length: 50 }, (_u, i) => {
          const fromA = i % 2 === 0;
          const cross = i % 5 === 0;
          return transfer(fromA ? a : b, fromA ? b : a, 'cNGN', '1', cross ? 'cGHS' : undefined);
        }),
      );
      const runs: ReconciliationRun[] = [];
      const reconciler = (async () => {
        for (let i = 0; i < 10; i += 1) runs.push(await runOf(service, 'full'));
      })();

      const responses = await transfers;
      await reconciler;

      expect(responses.filter((r) => r.status >= 500)).toEqual([]);
      expect(runs).toHaveLength(10);
      for (const run of runs) expect(run).toMatchObject({ ok: true, drift: [], unbalancedTx: [] });
      expect((await runOf(service, 'full')).ok).toBe(true);
    });
  });

  describe('one run at a time', () => {
    it('returns { skipped: true } when another run holds the lock, and writes no row', async () => {
      const lock = await holdLock();
      try {
        const result = await service.run('full');
        expect(result).toEqual({ skipped: true });
        expect(await scalar<number>('SELECT count(*)::int AS v FROM reconciliation_runs')).toBe(0);
      } finally {
        await lock.release();
      }
      expect(isSkipped(await service.run('full'))).toBe(false);
    });

    it('of two simultaneous runs, never both skip', async () => {
      await deposit(a, 'cNGN', '100');
      const results = await Promise.all([service.run('full'), service.run('full')]);
      expect(results.filter((r) => !isSkipped(r)).length).toBeGreaterThanOrEqual(1);
      expect(results.filter((r) => isSkipped(r)).length).toBeLessThanOrEqual(1);
    });

    it('releases the lock after a run, so the next one is not skipped', async () => {
      for (let i = 0; i < 3; i += 1)
        expect(isSkipped(await service.run('incremental'))).toBe(false);
    });
  });

  describe('incremental scope', () => {
    /** Three wallets with a cNGN and a cGHS balance each. */
    async function setUpWallets() {
      const x = a;
      const y = b;
      const z = (await t.agent.post('/v1/wallets').send({ email: 'rz@example.com' }).expect(201))
        .body.id as string;
      for (const w of [x, y, z]) {
        await oldDeposit(w, 'cNGN', 100_000_000n);
        await oldDeposit(w, 'cGHS', 100_000_000n);
      }
      // The accounts that never had a deposit were created just now: make them old too, so that
      // nothing is inside the window until a test touches it.
      await t.pool.query(`UPDATE accounts SET updated_at = now() - interval '1 day'`);
      return { x, y, z };
    }

    const lastOkStartedAt = () =>
      scalar<string>(
        `SELECT started_at::text AS v FROM reconciliation_runs WHERE ok ORDER BY started_at DESC LIMIT 1`,
      );

    it('skips untouched accounts, and covers accounts touched since the last OK run', async () => {
      const { x, y } = await setUpWallets();
      expect((await runOf(service, 'full')).ok).toBe(true);
      // Drift in an account nobody has touched for a day: out of the incremental scope.
      await t.pool.query('UPDATE accounts SET balance = balance + 1 WHERE id = $1', [
        await accountId(x, 'cNGN'),
      ]);

      const untouched = await runOf(service, 'incremental');
      expect(untouched).toMatchObject({ ok: true, accountsChecked: 0, drift: [] });
      expect(untouched.windowFrom).not.toBeNull();

      await deposit(y, 'cNGN', '1'); // touches exactly one account
      const touched = await runOf(service, 'incremental');
      expect(touched).toMatchObject({ ok: true, accountsChecked: 1 });

      // The same drift is found by the full run.
      const full = await runOf(service, 'full');
      expect(full.drift.map((d) => d.account_id)).toEqual([await accountId(x, 'cNGN')]);
    });

    it('includes an account last touched inside the overlap window, and excludes older ones', async () => {
      const { z } = await setUpWallets();
      expect((await runOf(service, 'full')).ok).toBe(true);
      const startedAt = await lastOkStartedAt();
      const inside = await accountId(z, 'cNGN');
      const outside = await accountId(z, 'cGHS');
      await t.pool.query(
        `UPDATE accounts SET balance = balance + 1, updated_at = $2::timestamptz - interval '1 minute'
          WHERE id = $1`,
        [inside, startedAt],
      );
      await t.pool.query(
        `UPDATE accounts SET balance = balance + 1, updated_at = $2::timestamptz - interval '1 hour'
          WHERE id = $1`,
        [outside, startedAt],
      );

      const run = await runOf(service, 'incremental');

      expect(run.drift.map((d) => d.account_id)).toEqual([inside]);
      expect(run.accountsChecked).toBe(1);
    });

    it('treats an incremental run with no earlier OK run as a full run', async () => {
      const { x } = await setUpWallets();
      await t.pool.query('UPDATE accounts SET balance = balance + 1 WHERE id = $1', [
        await accountId(x, 'cNGN'),
      ]);

      const run = await runOf(service, 'incremental');

      expect(run.windowFrom).toBeNull();
      expect(run.accountsChecked).toBe(15);
      expect(run.drift).toHaveLength(1);
    });

    it('does not move its window forward past a run that found drift', async () => {
      const { x } = await setUpWallets();
      expect((await runOf(service, 'full')).ok).toBe(true);
      const okAt = await lastOkStartedAt();
      await t.pool.query(
        `UPDATE accounts SET balance = balance + 1, updated_at = now() WHERE id = $1`,
        [await accountId(x, 'cNGN')],
      );
      expect((await runOf(service, 'incremental')).ok).toBe(false);
      // The failed run is not an OK run, so the next window still starts from the old OK run.
      expect(await lastOkStartedAt()).toBe(okAt);
      expect((await runOf(service, 'incremental')).ok).toBe(false);
    });
  });

  describe('snapshot and locks', () => {
    it('is not blocked or fooled by a posting that is still open: it sees none of it, then all of it', async () => {
      const account = await accountId(a, 'cNGN');
      const external = await t.ledger.getSystemAccountId('external', 'cNGN');
      const writer = await t.pool.connect();
      try {
        await writer.query('BEGIN');
        // A complete deposit, not yet committed. post() locks the user account row FOR UPDATE.
        await t.ledger.post(drizzle(writer), {
          transaction: {
            type: 'deposit',
            initiatorWalletId: a,
            sourceCurrency: 'cNGN',
            sourceAmount: 100n,
            destCurrency: 'cNGN',
            destAmount: 100n,
          },
          legs: [
            { accountId: external, amount: -100n },
            { accountId: account, amount: 100n },
          ],
          activity: [],
        });

        // Reconciliation takes no row locks, so it neither waits for that posting nor sees half of it.
        const during = await runOf(service, 'full');
        expect(during).toMatchObject({ ok: true, drift: [], unbalancedTx: [] });
        await writer.query('COMMIT');
      } finally {
        await writer.query('ROLLBACK').catch(() => undefined);
        writer.release();
      }

      const after = await runOf(service, 'full');
      expect(after).toMatchObject({ ok: true, drift: [], unbalancedTx: [] });
      // 100n is 100 minor units.
      expect(
        await scalar<string>('SELECT balance::text AS v FROM accounts WHERE id = $1', [account]),
      ).toBe('100');
    });

    it('releases the lock and discards the connection when a run fails', async () => {
      const failing = new ReconciliationService(
        {
          connect: async () => {
            const client = await t.pool.connect();
            const realQuery = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
            (client as unknown as { query: unknown }).query = (...args: unknown[]) =>
              typeof args[0] === 'string' && args[0].includes('REPEATABLE READ')
                ? Promise.reject(new Error('simulated failure'))
                : realQuery(...args);
            return client;
          },
        } as unknown as Pool,
        config,
      );

      await expect(failing.run('full')).rejects.toThrow('simulated failure');

      // The advisory lock did not leak: the next run is not skipped.
      expect(isSkipped(await service.run('full'))).toBe(false);
      expect(await scalar<number>('SELECT count(*)::int AS v FROM reconciliation_runs')).toBe(1);
    });
  });

  describe('incremental scope and planted ledger faults', () => {
    const PLANTED_NEW = '00000000-0000-7000-8000-0000000000aa';
    const PLANTED_OLD = '00000000-0000-7000-8000-0000000000bb';

    /** One entry on a user account, no balancing entry, no balance update. Triggers bypassed. */
    async function plant(options: {
      transactionId: string;
      walletId: string;
      accountId: string;
      createdAt: string;
    }): Promise<void> {
      const client = await t.pool.connect();
      try {
        await client.query('SET session_replication_role = replica');
        await client.query(
          `INSERT INTO transactions (id, type, initiator_wallet_id, source_currency, source_amount,
                                     dest_currency, dest_amount, created_at)
           VALUES ($1, 'deposit', $2, 'cNGN', 5, 'cNGN', 5, $3::timestamptz)`,
          [options.transactionId, options.walletId, options.createdAt],
        );
        await client.query(
          `INSERT INTO ledger_entries (transaction_id, account_id, currency, amount, created_at)
           VALUES ($1, $2, 'cNGN', 5, $3::timestamptz)`,
          [options.transactionId, options.accountId, options.createdAt],
        );
      } finally {
        await client.query('RESET session_replication_role');
        client.release();
      }
    }

    it('re-checks an account that received an entry in the window even though its row was not touched', async () => {
      await oldDeposit(a, 'cNGN', 100_000_000n);
      await oldDeposit(b, 'cNGN', 100_000_000n);
      expect((await runOf(service, 'full')).ok).toBe(true);
      const account = await accountId(a, 'cNGN');
      await plant({
        transactionId: PLANTED_NEW,
        walletId: a,
        accountId: account,
        createdAt: new Date(Date.now()).toISOString(),
      });

      const run = await runOf(service, 'incremental');

      expect(run.ok).toBe(false);
      expect(run.drift.map((d) => d.account_id)).toEqual([account]);
      expect(run.currencyNet['cNGN']).toBe('0.000005');
      expect(run.unbalancedTx).toEqual([{ transaction_id: PLANTED_NEW, entries: 1 }]);
    });

    it('leaves old faults to the full run: an incremental run does not look outside its window', async () => {
      await oldDeposit(a, 'cNGN', 100_000_000n);
      await oldDeposit(b, 'cNGN', 100_000_000n);
      expect((await runOf(service, 'full')).ok).toBe(true);
      const account = await accountId(b, 'cNGN');
      await plant({
        transactionId: PLANTED_OLD,
        walletId: b,
        accountId: account,
        createdAt: '2020-01-01T00:00:00Z',
      });

      const incremental = await runOf(service, 'incremental');
      expect(incremental).toMatchObject({ ok: true, drift: [], unbalancedTx: [] });
      expect(incremental.currencyNet['cNGN']).toBe('0.000000');

      const full = await runOf(service, 'full');
      expect(full.ok).toBe(false);
      expect(full.drift.map((d) => d.account_id)).toEqual([account]);
      expect(full.unbalancedTx).toEqual([{ transaction_id: PLANTED_OLD, entries: 1 }]);
      expect(full.currencyNet['cNGN']).toBe('0.000005');
    });
  });

  describe('admin endpoints', () => {
    it('answers 404 before any run, then returns the run that was triggered', async () => {
      await t.agent.get('/v1/admin/reconciliation').expect(404);

      const ran = await t.agent.post('/v1/admin/reconciliation/run').expect(200);
      expect(ran.body).toMatchObject({
        mode: 'full',
        ok: true,
        drift: [],
        unbalanced_transactions: [],
      });
      expect(ran.body.started_at).toMatch(/Z$/);

      const latest = await t.agent.get('/v1/admin/reconciliation').expect(200);
      expect(latest.body.id).toBe(ran.body.id);
    });

    it('accepts mode=incremental and rejects an unknown mode', async () => {
      const inc = await t.agent.post('/v1/admin/reconciliation/run?mode=incremental').expect(200);
      expect(inc.body.mode).toBe('incremental');
      await t.agent.post('/v1/admin/reconciliation/run?mode=repair').expect(400);
    });

    it('reports drift through the API', async () => {
      await deposit(a, 'cNGN', '100');
      const account = await accountId(a, 'cNGN');
      await t.pool.query('UPDATE accounts SET balance = balance + 1 WHERE id = $1', [account]);
      const res = await t.agent.post('/v1/admin/reconciliation/run?mode=full').expect(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.drift[0]).toMatchObject({ account_id: account, delta: '0.000001' });
    });

    it('answers { skipped: true } while another run holds the lock', async () => {
      const lock = await holdLock();
      try {
        const res = await t.agent.post('/v1/admin/reconciliation/run').expect(200);
        expect(res.body).toEqual({ skipped: true });
      } finally {
        await lock.release();
      }
    });

    it('exposes no way to repair: there is no write route besides run', async () => {
      await t.agent.put('/v1/admin/reconciliation').expect(404);
      await t.agent.delete('/v1/admin/reconciliation').expect(404);
      await t.agent.post('/v1/admin/reconciliation/repair').expect(404);
    });
  });
});
