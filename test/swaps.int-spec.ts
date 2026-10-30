import { AppError } from '../src/common/errors/app-error';
import { createTestApp, type TestApp } from './helpers/create-test-app';
import { guardRatesOutsideTransactions } from './helpers/rate-guard';

describe('swaps', () => {
  let t: TestApp;
  let walletId: string;
  let keyCounter = 0;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await t.reset();
    const res = await t.agent.post('/v1/wallets').send({ email: 'swap@example.com' }).expect(201);
    walletId = res.body.id as string;
  });

  const nextKey = () => `swap-key-${++keyCounter}`;

  const deposit = (currency: string, amount: string) =>
    t.agent
      .post(`/v1/wallets/${walletId}/deposits`)
      .set('Idempotency-Key', nextKey())
      .send({ currency, amount })
      .expect(201);

  // Pass null to send no Idempotency-Key at all (undefined would pick the default key).
  const swap = (body: unknown, key: string | null = nextKey(), id = walletId) => {
    const req = t.agent.post(`/v1/wallets/${id}/swaps`);
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send(body as object);
  };

  const sell = (amount: string, from = 'cNGN', to = 'USDx') =>
    ({ from_currency: from, to_currency: to, amount }) as const;

  async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
    const { rows } = await t.pool.query<{ v: T }>(sql, params);
    return rows[0]?.v as T;
  }

  const count = (table: string, where = 'true') =>
    scalar<number>(`SELECT count(*)::int AS v FROM ${table} WHERE ${where}`);

  const balance = async (currency: string): Promise<string> => {
    const res = await t.agent.get(`/v1/wallets/${walletId}`).expect(200);
    return (res.body.balances as { currency: string; amount: string }[]).find(
      (b) => b.currency === currency,
    )?.amount as string;
  };

  async function expectLedgerBalanced(): Promise<void> {
    const sums = await t.pool.query<{ currency: string; sum: string }>(
      'SELECT currency, sum(amount)::text AS sum FROM ledger_entries GROUP BY currency',
    );
    for (const row of sums.rows) expect(row.sum).toBe('0');
    const drift = await t.pool.query(
      `SELECT 1 FROM accounts a
        WHERE a.kind = 'user'
          AND a.balance <> coalesce((SELECT sum(amount) FROM ledger_entries e WHERE e.account_id = a.id), 0)`,
    );
    expect(drift.rowCount).toBe(0);
  }

  describe('a successful swap', () => {
    it('converts cNGN to USDx: balances, four entries, a balanced ledger and a reproducible rate', async () => {
      await deposit('cNGN', '3000');

      const res = await swap(sell('1500')).expect(201);

      // 1500 cNGN at the recorded rate 0.000666666666 floors to 0.999999 USDx.
      expect(res.headers['location']).toBe(`/v1/transactions/${res.body.transaction.id}`);
      expect(res.body.transaction).toMatchObject({
        type: 'swap',
        source_currency: 'cNGN',
        source_amount: '1500.000000',
        dest_currency: 'USDx',
        dest_amount: '0.999999',
        rate: '0.000666666666',
        rate_source: 'static',
      });
      expect(res.body.transaction.rate_as_of).toMatch(/Z$/);
      const rates = await t.agent.get('/v1/fx/rates').expect(200);
      expect(res.body.transaction.rate_as_of).toBe(rates.body.as_of);
      expect(res.body.balances_after).toEqual([
        { currency: 'cNGN', amount: '1500.000000' },
        { currency: 'cGHS', amount: '0.000000' },
        { currency: 'cXAF', amount: '0.000000' },
        { currency: 'USDx', amount: '0.999999' },
        { currency: 'EURx', amount: '0.000000' },
      ]);

      const entries = await t.pool.query<{ kind: string; currency: string; amount: string }>(
        `SELECT a.kind, a.currency, e.amount::text AS amount
           FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
          WHERE e.transaction_id = $1 ORDER BY e.id`,
        [res.body.transaction.id],
      );
      expect(entries.rows).toEqual([
        { kind: 'user', currency: 'cNGN', amount: '-1500000000' },
        { kind: 'fx_pool', currency: 'cNGN', amount: '1500000000' },
        { kind: 'fx_pool', currency: 'USDx', amount: '-999999' },
        { kind: 'user', currency: 'USDx', amount: '999999' },
      ]);
      await expectLedgerBalanced();
    });

    it('records a rate that reproduces dest_amount exactly: floor(source x rate)', async () => {
      await deposit('cNGN', '3000');
      const res = await swap(sell('1234.567891')).expect(201);

      const row = await t.pool.query<{
        rate: string;
        rate_source: string;
        rate_as_of: Date;
        source_amount: string;
        dest_amount: string;
        idempotency_key: string;
      }>(
        `SELECT rate::text, rate_source, rate_as_of, source_amount::text, dest_amount::text, idempotency_key
           FROM transactions WHERE id = $1`,
        [res.body.transaction.id],
      );
      const tx = row.rows[0];
      expect(tx?.rate).toBe('0.000666666666');
      expect(tx?.rate_source).toBe('static');
      expect(tx?.rate_as_of.toISOString()).toBe(res.body.transaction.rate_as_of);
      expect(tx?.idempotency_key).toMatch(/^swap-key-/);

      const reproduced =
        (BigInt(tx?.source_amount ?? '0') * BigInt((tx?.rate ?? '').replace('.', ''))) / 10n ** 12n;
      expect(reproduced.toString()).toBe(tx?.dest_amount);
    });

    it('writes one swap activity row with both the out and the in side', async () => {
      await deposit('cNGN', '100');
      await swap(sell('10')).expect(201);

      const { rows } = await t.pool.query(
        `SELECT activity_type, currency_out, amount_out::text, currency_in, amount_in::text
           FROM wallet_activity WHERE activity_type = 'swap'`,
      );
      expect(rows).toEqual([
        {
          activity_type: 'swap',
          currency_out: 'cNGN',
          amount_out: '10000000',
          currency_in: 'USDx',
          amount_in: '6666',
        },
      ]);
    });

    it('accepts case-insensitive currencies and returns the canonical spelling', async () => {
      await deposit('cNGN', '100');
      const res = await swap({ from_currency: 'cngn', to_currency: 'usdx', amount: '10' }).expect(
        201,
      );
      expect(res.body.transaction).toMatchObject({
        source_currency: 'cNGN',
        dest_currency: 'USDx',
      });
    });

    it('swapping the entire balance succeeds and leaves exactly zero', async () => {
      await deposit('cNGN', '1500');

      await swap(sell('1500')).expect(201);

      expect(await balance('cNGN')).toBe('0.000000');
      expect(await balance('USDx')).toBe('0.999999');
      await expectLedgerBalanced();
    });

    it('rounding dust stays in the fx pool: it gains the full sold amount, pays only the floor', async () => {
      await deposit('cNGN', '100');
      await swap(sell('10')).expect(201);

      const pool = await t.pool.query<{ currency: string; sum: string }>(
        `SELECT a.currency, sum(e.amount)::text AS sum
           FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
          WHERE a.kind = 'fx_pool' GROUP BY a.currency`,
      );
      const byCurrency = Object.fromEntries(pool.rows.map((r) => [r.currency, r.sum]));
      expect(byCurrency).toEqual({ cNGN: '10000000', USDx: '-6666' });
    });
  });

  describe('concurrency', () => {
    it('20 simultaneous swaps of 10 cNGN from a 100 cNGN wallet: exactly 10 succeed, 10 are INSUFFICIENT_FUNDS', async () => {
      await deposit('cNGN', '100');

      const responses = await Promise.all(
        Array.from({ length: 20 }, (_unused, i) => swap(sell('10'), `race-${i}`)),
      );

      const statuses = responses.map((r) => r.status);
      expect(statuses.filter((s) => s >= 500)).toEqual([]);
      expect(statuses.filter((s) => s === 201)).toHaveLength(10);
      const rejected = responses.filter((r) => r.status === 422);
      expect(rejected).toHaveLength(10);
      for (const r of rejected) expect(r.body).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });

      expect(await balance('cNGN')).toBe('0.000000');
      expect(await balance('USDx')).toBe('0.066660'); // 10 x floor(10 x 0.000666666666)
      expect(await count('transactions', `type = 'swap'`)).toBe(10);
      expect(await count('ledger_entries')).toBe(2 + 10 * 4);
      await expectLedgerBalanced();

      // Every outcome, including the 10 rejections, is stored against its own key.
      const stored = await t.pool.query<{ status_code: number; n: number }>(
        `SELECT status_code, count(*)::int AS n FROM idempotency_keys
          WHERE key LIKE 'race-%' GROUP BY status_code ORDER BY status_code`,
      );
      expect(stored.rows).toEqual([
        { status_code: 201, n: 10 },
        { status_code: 422, n: 10 },
      ]);
    });

    it('never deadlocks or fails with a 5xx when swaps run in both directions alongside deposits', async () => {
      await deposit('cNGN', '100');
      await deposit('USDx', '100');

      const jobs = [
        ...Array.from({ length: 10 }, (_u, i) => swap(sell('10', 'cNGN', 'USDx'), `mix-a-${i}`)),
        ...Array.from({ length: 10 }, (_u, i) => swap(sell('10', 'USDx', 'cNGN'), `mix-b-${i}`)),
        ...Array.from({ length: 5 }, (_u, i) =>
          t.agent
            .post(`/v1/wallets/${walletId}/deposits`)
            .set('Idempotency-Key', `mix-d-${i}`)
            .send({ currency: 'cNGN', amount: '1' }),
        ),
      ];
      const responses = await Promise.all(jobs);

      expect(responses.filter((r) => r.status >= 500)).toEqual([]);
      for (const r of responses) expect([201, 422]).toContain(r.status);
      await expectLedgerBalanced();
    });

    it('10 simultaneous identical swaps run once and replay the rest, with no 5xx', async () => {
      await deposit('cNGN', '100');

      const responses = await Promise.all(
        Array.from({ length: 10 }, () => swap(sell('10'), 'same-key-race')),
      );

      expect(responses.map((r) => r.status)).toEqual(Array(10).fill(201));
      expect(new Set(responses.map((r) => r.text)).size).toBe(1);
      expect(responses.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(9);
      expect(await count('transactions', `type = 'swap'`)).toBe(1);
      expect(await balance('cNGN')).toBe('90.000000');
    });
  });

  describe('rejections', () => {
    it('rejects dust with AMOUNT_TOO_SMALL, changes nothing, and stores the rejection against the key', async () => {
      await deposit('cNGN', '100');

      const first = await swap(sell('0.000001'), 'dust-key').expect(422);
      const second = await swap(sell('0.000001'), 'dust-key').expect(422);

      expect(first.body).toMatchObject({ code: 'AMOUNT_TOO_SMALL', status: 422 });
      expect(second.body).toMatchObject({ code: 'AMOUNT_TOO_SMALL' });
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      expect(await balance('cNGN')).toBe('100.000000');
      expect(await count('transactions', `type = 'swap'`)).toBe(0);
      expect(
        await scalar<number>(
          `SELECT status_code AS v FROM idempotency_keys WHERE key = 'dust-key'`,
        ),
      ).toBe(422);
    });

    it('stores INSUFFICIENT_FUNDS against the key, so a retry after funding still replays it', async () => {
      const first = await swap(sell('10'), 'poor-key').expect(422);
      expect(first.body).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });

      await deposit('cNGN', '100');
      const retry = await swap(sell('10'), 'poor-key').expect(422);

      expect(retry.body).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(await count('transactions', `type = 'swap'`)).toBe(0);
    });

    it('rejects a debit from a frozen wallet with WALLET_FROZEN, stored and replayable', async () => {
      await deposit('cNGN', '100');
      await t.pool.query(`UPDATE wallets SET status = 'frozen' WHERE id = $1`, [walletId]);

      const first = await swap(sell('10'), 'frozen-key').expect(422);
      const second = await swap(sell('10'), 'frozen-key').expect(422);

      expect(first.body).toMatchObject({ code: 'WALLET_FROZEN' });
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(await balance('cNGN')).toBe('100.000000');
    });

    it('rejects the same currency on both sides with 400 SAME_CURRENCY_SWAP', async () => {
      await deposit('cNGN', '100');
      const res = await swap(sell('10', 'cNGN', 'cNGN')).expect(400);
      expect(res.body).toMatchObject({ code: 'SAME_CURRENCY_SWAP' });
      const mixedCase = await swap(sell('10', 'cNGN', 'CNGN')).expect(400);
      expect(mixedCase.body).toMatchObject({ code: 'SAME_CURRENCY_SWAP' });
      expect(await count('idempotency_keys', `key LIKE 'swap-key-%' AND scope LIKE '%swaps'`)).toBe(
        0,
      );
    });

    it('rejects an unsupported currency with 400 UNSUPPORTED_CURRENCY', async () => {
      const res = await swap(sell('10', 'cNGN', 'XYZ')).expect(400);
      expect(res.body).toMatchObject({ code: 'UNSUPPORTED_CURRENCY' });
      await swap(sell('10', 'BTC', 'USDx')).expect(400);
    });

    it('rejects a JSON number amount, a missing field and an unknown field with 400', async () => {
      await swap({ from_currency: 'cNGN', to_currency: 'USDx', amount: 10 }).expect(400);
      await swap({ from_currency: 'cNGN', amount: '10' }).expect(400);
      await swap({ ...sell('10'), extra: 'x' }).expect(400);
    });

    it.each(['0', '-1', '1e3', ' 5', '.5', '5.', '1.0000001'])(
      'rejects the amount %j with 400',
      async (amount) => {
        const res = await swap(sell(amount)).expect(400);
        expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
      },
    );

    it('rejects an amount over the maximum with 422 AMOUNT_LIMIT_EXCEEDED', async () => {
      const res = await swap(sell('1000000000.000001')).expect(422);
      expect(res.body).toMatchObject({ code: 'AMOUNT_LIMIT_EXCEEDED' });
    });

    it('answers 404 for an unknown wallet without keeping the key', async () => {
      const unknown = '01a18e56-7952-729f-ab7d-cb9426c0fd98';
      const res = await swap(sell('10'), 'ghost-key', unknown).expect(404);
      expect(res.body).toMatchObject({ code: 'WALLET_NOT_FOUND' });
      expect(await count('idempotency_keys', `key = 'ghost-key'`)).toBe(0);
    });

    it('requires an Idempotency-Key and writes nothing without one', async () => {
      await deposit('cNGN', '100');
      const res = await swap(sell('10'), null).expect(400);
      expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
      expect(await count('transactions', `type = 'swap'`)).toBe(0);
    });
  });

  describe('idempotency', () => {
    it('replays the same key and body: one transaction, an identical response', async () => {
      await deposit('cNGN', '100');

      const first = await swap(sell('10'), 'replay-key').expect(201);
      const second = await swap(sell('10'), 'replay-key').expect(201);

      expect(second.text).toBe(first.text);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.headers['location']).toBe(first.headers['location']);
      expect(await count('transactions', `type = 'swap'`)).toBe(1);
      expect(await balance('cNGN')).toBe('90.000000');
    });

    it('treats "10" and "10.0" (and currency case) as the same request', async () => {
      await deposit('cNGN', '100');
      const first = await swap(sell('10'), 'format-key').expect(201);
      const second = await swap(sell('10.0', 'CNGN', 'usdx'), 'format-key').expect(201);
      expect(second.text).toBe(first.text);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(await count('transactions', `type = 'swap'`)).toBe(1);
    });

    it('rejects the same key with a different body: 422 IDEMPOTENCY_KEY_REUSED', async () => {
      await deposit('cNGN', '100');
      await swap(sell('10'), 'reuse-key').expect(201);

      const different = await swap(sell('11'), 'reuse-key').expect(422);
      expect(different.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      const otherTarget = await swap(sell('10', 'cNGN', 'EURx'), 'reuse-key').expect(422);
      expect(otherTarget.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      expect(await count('transactions', `type = 'swap'`)).toBe(1);
    });

    it('replays an earlier success even while FX is unavailable, and releases a key that hit the outage', async () => {
      await deposit('cNGN', '100');
      const first = await swap(sell('10'), 'outage-key').expect(201);

      jest.spyOn(t.rates, 'getRate').mockImplementation(() => {
        throw new AppError('FX_UNAVAILABLE', { retryAfterSeconds: 1 });
      });

      const replay = await swap(sell('10'), 'outage-key').expect(201);
      expect(replay.text).toBe(first.text);
      expect(replay.headers['idempotent-replayed']).toBe('true');

      const fresh = await swap(sell('10'), 'outage-new-key').expect(503);
      expect(fresh.body).toMatchObject({ code: 'FX_UNAVAILABLE' });
      expect(fresh.headers['retry-after']).toBe('1');
      expect(await count('idempotency_keys', `key = 'outage-new-key'`)).toBe(0);

      jest.restoreAllMocks();
      await swap(sell('10'), 'outage-new-key').expect(201);
    });
  });

  describe('ordering of checks', () => {
    const ghost = '01a18e56-7952-729f-ab7d-cb9426c0fd98';

    it('answers 404 for an unknown wallet even when the amount is dust, and stores no key', async () => {
      const res = await swap(sell('0.000001'), 'ghost-dust', ghost).expect(404);
      expect(res.body).toMatchObject({ code: 'WALLET_NOT_FOUND' });
      expect(await count('idempotency_keys', `key = 'ghost-dust'`)).toBe(0);
    });

    it('answers 404, not 503, for an unknown wallet during an FX outage', async () => {
      jest.spyOn(t.rates, 'getRate').mockImplementation(() => {
        throw new AppError('FX_UNAVAILABLE');
      });
      const res = await swap(sell('10'), 'ghost-outage', ghost).expect(404);
      expect(res.body).toMatchObject({ code: 'WALLET_NOT_FOUND' });
      expect(await count('idempotency_keys', `key = 'ghost-outage'`)).toBe(0);
    });

    it.each([
      ['from_currency', { from_currency: null, to_currency: 'USDx', amount: '10' }],
      ['to_currency', { from_currency: 'cNGN', to_currency: null, amount: '10' }],
      ['amount', { from_currency: 'cNGN', to_currency: 'USDx', amount: null }],
    ])('rejects a null %s with 400', async (_field, body) => {
      const res = await swap(body).expect(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('replays the original response (and rate) after the live rate has changed', async () => {
      await deposit('cNGN', '100');
      const first = await swap(sell('10'), 'rate-moved').expect(201);

      jest.spyOn(t.rates, 'getRate').mockReturnValue({
        rate: '0.001000000000',
        source: 'static',
        asOf: new Date('2030-01-01T00:00:00.000Z'),
      });
      const replay = await swap(sell('10'), 'rate-moved').expect(201);

      expect(replay.text).toBe(first.text);
      expect(replay.body.transaction.rate).toBe('0.000666666666');
      expect(replay.headers['idempotent-replayed']).toBe('true');
    });
  });

  describe('rates are resolved outside database transactions', () => {
    it('never calls getRate while a transaction is open', async () => {
      await deposit('cNGN', '100');
      const guard = guardRatesOutsideTransactions(t);
      try {
        await swap(sell('10')).expect(201);
        await swap(sell('0.000001')).expect(422);

        expect(guard.rateCalls).toBe(2);
        expect(guard.transactionsOpened).toBeGreaterThanOrEqual(2);
      } finally {
        guard.restore();
      }
    });

    it('the guard itself fails a getRate call made inside a transaction', async () => {
      const guard = guardRatesOutsideTransactions(t);
      try {
        await expect(
          t.transactions.run(() => Promise.resolve(t.rates.getRate('cNGN', 'USDx'))),
        ).rejects.toThrow(/transaction was open/);
      } finally {
        guard.restore();
      }
    });
  });
});

describe('swaps with a small connection pool', () => {
  let small: TestApp;

  beforeAll(async () => {
    small = await createTestApp({ poolMax: 5 });
  });

  afterAll(async () => {
    await small.close();
  });

  it('20 simultaneous swaps still give exactly 10 successes and 10 INSUFFICIENT_FUNDS', async () => {
    await small.reset();
    const wallet = await small.agent
      .post('/v1/wallets')
      .send({ email: 'pool@example.com' })
      .expect(201);
    const id = wallet.body.id as string;
    await small.agent
      .post(`/v1/wallets/${id}/deposits`)
      .set('Idempotency-Key', 'pool-dep')
      .send({ currency: 'cNGN', amount: '100' })
      .expect(201);

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_u, i) =>
        small.agent
          .post(`/v1/wallets/${id}/swaps`)
          .set('Idempotency-Key', `pool-${i}`)
          .send({ from_currency: 'cNGN', to_currency: 'USDx', amount: '10' }),
      ),
    );

    expect(responses.filter((r) => r.status >= 500)).toEqual([]);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(10);
    expect(responses.filter((r) => r.status === 422)).toHaveLength(10);
    const left = await small.pool.query<{ balance: string }>(
      `SELECT balance::text FROM accounts WHERE wallet_id = $1 AND currency = 'cNGN'`,
      [id],
    );
    expect(left.rows[0]?.balance).toBe('0');
  });
});
