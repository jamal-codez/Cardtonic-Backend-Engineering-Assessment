import { AppError } from '../src/common/errors/app-error';
import { createTestApp, type TestApp } from './helpers/create-test-app';
import { guardRatesOutsideTransactions } from './helpers/rate-guard';

describe('transfers', () => {
  let t: TestApp;
  let a: string;
  let b: string;
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
    a = (await t.agent.post('/v1/wallets').send({ email: 'a@example.com' }).expect(201)).body.id;
    b = (await t.agent.post('/v1/wallets').send({ email: 'b@example.com' }).expect(201)).body.id;
  });

  const nextKey = () => `transfer-key-${++keyCounter}`;

  const deposit = (walletId: string, currency: string, amount: string) =>
    t.agent
      .post(`/v1/wallets/${walletId}/deposits`)
      .set('Idempotency-Key', nextKey())
      .send({ currency, amount })
      .expect(201);

  // Pass null as the key to send no Idempotency-Key at all.
  const transfer = (body: unknown, key: string | null = nextKey(), from = a) => {
    const req = t.agent.post(`/v1/wallets/${from}/transfers`);
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send(body as object);
  };

  const send = (amount: string, currency = 'cNGN', to = b, destination?: string) => ({
    to_wallet_id: to,
    source_currency: currency,
    ...(destination ? { destination_currency: destination } : {}),
    amount,
  });

  async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
    const { rows } = await t.pool.query<{ v: T }>(sql, params);
    return rows[0]?.v as T;
  }

  const count = (table: string, where = 'true') =>
    scalar<number>(`SELECT count(*)::int AS v FROM ${table} WHERE ${where}`);

  const balance = async (walletId: string, currency: string): Promise<string> => {
    const res = await t.agent.get(`/v1/wallets/${walletId}`).expect(200);
    return (res.body.balances as { currency: string; amount: string }[]).find(
      (x) => x.currency === currency,
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

  describe('same currency', () => {
    it('moves the exact amount with 2 entries and 2 activity rows, null rate fields and no rate lookups', async () => {
      await deposit(a, 'cNGN', '100');
      const getRate = jest.spyOn(t.rates, 'getRate');

      const res = await transfer(send('40.5')).expect(201);

      expect(getRate).not.toHaveBeenCalled();
      expect(res.headers['location']).toBe(`/v1/transactions/${res.body.transaction.id}`);
      expect(res.body.transaction).toMatchObject({
        type: 'transfer',
        sender_wallet_id: a,
        receiver_wallet_id: b,
        source_currency: 'cNGN',
        source_amount: '40.500000',
        dest_currency: 'cNGN',
        dest_amount: '40.500000',
      });
      expect(res.body.transaction).not.toHaveProperty('rate');
      expect(res.body.transaction).not.toHaveProperty('rate_source');
      // balances_after is the sender's.
      expect(res.body.balances_after[0]).toEqual({ currency: 'cNGN', amount: '59.500000' });
      expect(await balance(a, 'cNGN')).toBe('59.500000');
      expect(await balance(b, 'cNGN')).toBe('40.500000');

      const row = await t.pool.query(
        `SELECT type, initiator_wallet_id, counterparty_wallet_id, source_amount::text,
                dest_amount::text, rate, rate_source, rate_as_of, idempotency_key
           FROM transactions WHERE id = $1`,
        [res.body.transaction.id],
      );
      expect(row.rows[0]).toMatchObject({
        type: 'transfer',
        initiator_wallet_id: a,
        counterparty_wallet_id: b,
        source_amount: '40500000',
        dest_amount: '40500000',
        rate: null,
        rate_source: null,
        rate_as_of: null,
      });

      const entries = await t.pool.query<{ wallet_id: string; amount: string }>(
        `SELECT acc.wallet_id, e.amount::text AS amount
           FROM ledger_entries e JOIN accounts acc ON acc.id = e.account_id
          WHERE e.transaction_id = $1 ORDER BY e.id`,
        [res.body.transaction.id],
      );
      expect(entries.rows).toEqual([
        { wallet_id: a, amount: '-40500000' },
        { wallet_id: b, amount: '40500000' },
      ]);

      const activity = await t.pool.query(
        `SELECT wallet_id, activity_type, currency_out, amount_out::text, currency_in,
                amount_in::text, counterparty_wallet_id
           FROM wallet_activity WHERE activity_type LIKE 'transfer%' ORDER BY activity_type`,
      );
      expect(activity.rows).toEqual([
        {
          wallet_id: b,
          activity_type: 'transfer_in',
          currency_out: null,
          amount_out: null,
          currency_in: 'cNGN',
          amount_in: '40500000',
          counterparty_wallet_id: a,
        },
        {
          wallet_id: a,
          activity_type: 'transfer_out',
          currency_out: 'cNGN',
          amount_out: '40500000',
          currency_in: null,
          amount_in: null,
          counterparty_wallet_id: b,
        },
      ]);
      await expectLedgerBalanced();
    });

    it('treats an explicit destination_currency equal to the source as the same request (replay)', async () => {
      await deposit(a, 'cNGN', '100');
      const first = await transfer(send('10'), 'dest-default').expect(201);
      const second = await transfer(send('10.0', 'CNGN', b, 'cngn'), 'dest-default').expect(201);
      expect(second.text).toBe(first.text);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(await count('transactions', `type = 'transfer'`)).toBe(1);
    });
  });

  describe('cross currency', () => {
    it('converts cNGN to cGHS: correct amount, 4 entries, reproducible rate, balanced ledger', async () => {
      await deposit(a, 'cNGN', '1500');

      const res = await transfer(send('1500', 'cNGN', b, 'cGHS')).expect(201);

      // 1500 cNGN at 0.010000000000 is exactly 15 cGHS.
      expect(res.body.transaction).toMatchObject({
        type: 'transfer',
        source_currency: 'cNGN',
        source_amount: '1500.000000',
        dest_currency: 'cGHS',
        dest_amount: '15.000000',
        rate: '0.010000000000',
        rate_source: 'static',
      });
      expect(res.body.transaction.rate_as_of).toMatch(/Z$/);
      expect(await balance(a, 'cNGN')).toBe('0.000000');
      expect(await balance(b, 'cGHS')).toBe('15.000000');
      expect(await balance(b, 'cNGN')).toBe('0.000000');

      const entries = await t.pool.query<{ kind: string; currency: string; amount: string }>(
        `SELECT acc.kind, acc.currency, e.amount::text AS amount
           FROM ledger_entries e JOIN accounts acc ON acc.id = e.account_id
          WHERE e.transaction_id = $1 ORDER BY e.id`,
        [res.body.transaction.id],
      );
      expect(entries.rows).toEqual([
        { kind: 'user', currency: 'cNGN', amount: '-1500000000' },
        { kind: 'fx_pool', currency: 'cNGN', amount: '1500000000' },
        { kind: 'fx_pool', currency: 'cGHS', amount: '-15000000' },
        { kind: 'user', currency: 'cGHS', amount: '15000000' },
      ]);

      const activity = await t.pool.query(
        `SELECT wallet_id, activity_type, currency_out, currency_in
           FROM wallet_activity WHERE activity_type LIKE 'transfer%' ORDER BY activity_type`,
      );
      expect(activity.rows).toEqual([
        { wallet_id: b, activity_type: 'transfer_in', currency_out: null, currency_in: 'cGHS' },
        { wallet_id: a, activity_type: 'transfer_out', currency_out: 'cNGN', currency_in: null },
      ]);
      await expectLedgerBalanced();
    });

    it('records a rate that reproduces dest_amount exactly: floor(source x rate)', async () => {
      await deposit(a, 'cNGN', '3000');
      const res = await transfer(send('1234.567891', 'cNGN', b, 'USDx')).expect(201);

      const row = await t.pool.query<{ rate: string; source_amount: string; dest_amount: string }>(
        `SELECT rate::text, source_amount::text, dest_amount::text FROM transactions WHERE id = $1`,
        [res.body.transaction.id],
      );
      const tx = row.rows[0];
      const reproduced =
        (BigInt(tx?.source_amount ?? '0') * BigInt((tx?.rate ?? '').replace('.', ''))) / 10n ** 12n;
      expect(reproduced.toString()).toBe(tx?.dest_amount);
      expect(await balance(b, 'USDx')).toBe(res.body.transaction.dest_amount);
      await expectLedgerBalanced();
    });

    it('rejects dust with AMOUNT_TOO_SMALL, stores it against the key and moves nothing', async () => {
      await deposit(a, 'cNGN', '100');
      const first = await transfer(send('0.000001', 'cNGN', b, 'USDx'), 'dust-key').expect(422);
      const second = await transfer(send('0.000001', 'cNGN', b, 'USDx'), 'dust-key').expect(422);

      expect(first.body).toMatchObject({ code: 'AMOUNT_TOO_SMALL' });
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(await balance(a, 'cNGN')).toBe('100.000000');
      expect(await count('transactions', `type = 'transfer'`)).toBe(0);
    });

    it('never calls getRate while a database transaction is open', async () => {
      await deposit(a, 'cNGN', '100');
      const guard = guardRatesOutsideTransactions(t);
      try {
        await transfer(send('10', 'cNGN', b, 'cGHS')).expect(201);
        expect(guard.rateCalls).toBe(1);
        expect(guard.transactionsOpened).toBeGreaterThanOrEqual(1);
      } finally {
        guard.restore();
      }
    });
  });

  describe('FX independence', () => {
    it('keeps same-currency transfers working while FX is unavailable', async () => {
      await deposit(a, 'cNGN', '100');
      jest.spyOn(t.rates, 'getRate').mockImplementation(() => {
        throw new AppError('FX_UNAVAILABLE');
      });

      await transfer(send('10')).expect(201);
      expect(await balance(b, 'cNGN')).toBe('10.000000');
    });

    it('answers 503 for a cross-currency transfer during an outage and releases the key', async () => {
      await deposit(a, 'cNGN', '100');
      jest.spyOn(t.rates, 'getRate').mockImplementation(() => {
        throw new AppError('FX_UNAVAILABLE', { retryAfterSeconds: 1 });
      });

      const res = await transfer(send('10', 'cNGN', b, 'cGHS'), 'outage-key').expect(503);

      expect(res.body).toMatchObject({ code: 'FX_UNAVAILABLE' });
      expect(res.headers['retry-after']).toBe('1');
      expect(await count('idempotency_keys', `key = 'outage-key'`)).toBe(0);
      jest.restoreAllMocks();
      await transfer(send('10', 'cNGN', b, 'cGHS'), 'outage-key').expect(201);
    });
  });

  describe('concurrency', () => {
    it('does not deadlock when 10 A to B and 10 B to A transfers run at once', async () => {
      await deposit(a, 'cNGN', '100');
      await deposit(b, 'cNGN', '100');
      const post = jest.spyOn(t.ledger, 'post');

      const responses = await Promise.all([
        ...Array.from({ length: 10 }, (_u, i) => transfer(send('1'), `ab-${i}`, a)),
        ...Array.from({ length: 10 }, (_u, i) => transfer(send('2', 'cNGN', a), `ba-${i}`, b)),
      ]);

      expect(responses.filter((r) => r.status >= 500)).toEqual([]);
      expect(responses.map((r) => r.status)).toEqual(Array(20).fill(201));
      // One posting per request: a deadlock retried by withTransaction would show up as more.
      expect(post).toHaveBeenCalledTimes(20);
      // Start 100 each; A sent 10 x 1 and received 10 x 2; B the reverse.
      expect(await balance(a, 'cNGN')).toBe('110.000000');
      expect(await balance(b, 'cNGN')).toBe('90.000000');
      const net = await t.pool.query<{ wallet_id: string; summed: string }>(
        `SELECT acc.wallet_id, sum(e.amount)::text AS summed
           FROM ledger_entries e JOIN accounts acc ON acc.id = e.account_id
          WHERE acc.kind = 'user' GROUP BY acc.wallet_id`,
      );
      const byWallet = Object.fromEntries(net.rows.map((r) => [r.wallet_id, r.summed]));
      expect(byWallet).toEqual({ [a]: '110000000', [b]: '90000000' });
      await expectLedgerBalanced();
    });

    it('lets exactly one of 10 simultaneous transfers that each need 60% of the balance succeed', async () => {
      await deposit(a, 'cNGN', '100');

      const responses = await Promise.all(
        Array.from({ length: 10 }, (_u, i) => transfer(send('60'), `od-${i}`)),
      );

      expect(responses.filter((r) => r.status >= 500)).toEqual([]);
      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
      const rejected = responses.filter((r) => r.status === 422);
      expect(rejected).toHaveLength(9);
      for (const r of rejected) expect(r.body).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
      expect(await balance(a, 'cNGN')).toBe('40.000000');
      expect(await balance(b, 'cNGN')).toBe('60.000000');
      await expectLedgerBalanced();
    });

    it('runs cross-currency transfers in both directions at once: all succeed, no retried deadlock, no drift', async () => {
      await deposit(a, 'cNGN', '1000');
      await deposit(b, 'cGHS', '1000');
      const post = jest.spyOn(t.ledger, 'post');

      // a sends 8 x 100 cNGN (has 1000); b sends 8 x 10 cGHS (has 1000): every transfer is funded.
      const responses = await Promise.all([
        ...Array.from({ length: 8 }, (_u, i) =>
          transfer(send('100', 'cNGN', b, 'cGHS'), `x-ab-${i}`, a),
        ),
        ...Array.from({ length: 8 }, (_u, i) =>
          transfer(send('10', 'cGHS', a, 'cNGN'), `x-ba-${i}`, b),
        ),
      ]);

      expect(responses.map((r) => r.status)).toEqual(Array(16).fill(201));
      // One posting per request: a deadlock retried by withTransaction would show up as more.
      expect(post).toHaveBeenCalledTimes(16);
      await expectLedgerBalanced();
    });
  });

  describe('rejections', () => {
    it('rejects a self-transfer with 400 SELF_TRANSFER, in any currency and any letter case', async () => {
      await deposit(a, 'cNGN', '100');
      for (const body of [
        send('10', 'cNGN', a),
        send('10', 'cNGN', a, 'cGHS'),
        send('10', 'cNGN', a.toUpperCase()),
      ]) {
        const res = await transfer(body).expect(400);
        expect(res.body).toMatchObject({ code: 'SELF_TRANSFER' });
      }
      expect(await count('transactions', `type = 'transfer'`)).toBe(0);
      expect(await count('idempotency_keys', `scope LIKE '%transfers'`)).toBe(0);
    });

    it('answers 404 RECIPIENT_NOT_FOUND for an unknown recipient, even for dust, and keeps no key', async () => {
      await deposit(a, 'cNGN', '100');
      const ghost = '01a18e56-7952-729f-ab7d-cb9426c0fd98';

      const res = await transfer(send('10', 'cNGN', ghost), 'ghost-recipient').expect(404);
      expect(res.body).toMatchObject({ code: 'RECIPIENT_NOT_FOUND' });
      const dust = await transfer(send('0.000001', 'cNGN', ghost, 'USDx'), 'ghost-dust').expect(
        404,
      );
      expect(dust.body).toMatchObject({ code: 'RECIPIENT_NOT_FOUND' });
      expect(await count('idempotency_keys', `scope LIKE '%transfers'`)).toBe(0);
    });

    it('answers 404 WALLET_NOT_FOUND for an unknown sender', async () => {
      const ghost = '01a18e56-7952-729f-ab7d-cb9426c0fd98';
      const res = await transfer(send('10'), 'ghost-sender', ghost).expect(404);
      expect(res.body).toMatchObject({ code: 'WALLET_NOT_FOUND' });
      expect(await count('idempotency_keys', `key = 'ghost-sender'`)).toBe(0);
    });

    it('rejects insufficient funds with 422, stored against the key so a retry still replays it', async () => {
      const first = await transfer(send('10'), 'poor-key').expect(422);
      expect(first.body).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
      expect(await count('transactions', `type = 'transfer'`)).toBe(0);

      await deposit(a, 'cNGN', '100');
      const retry = await transfer(send('10'), 'poor-key').expect(422);

      expect(retry.body).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(
        await scalar<number>(
          `SELECT status_code AS v FROM idempotency_keys WHERE key = 'poor-key'`,
        ),
      ).toBe(422);
      expect(await count('transactions', `type = 'transfer'`)).toBe(0);
    });

    it('rejects a frozen sender with 422 WALLET_FROZEN (stored), but a frozen recipient still receives', async () => {
      await deposit(a, 'cNGN', '100');
      await t.pool.query(`UPDATE wallets SET status = 'frozen' WHERE id = $1`, [a]);

      const first = await transfer(send('10'), 'frozen-key').expect(422);
      const second = await transfer(send('10'), 'frozen-key').expect(422);
      expect(first.body).toMatchObject({ code: 'WALLET_FROZEN' });
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(await balance(a, 'cNGN')).toBe('100.000000');

      await t.pool.query(`UPDATE wallets SET status = 'active' WHERE id = $1`, [a]);
      await t.pool.query(`UPDATE wallets SET status = 'frozen' WHERE id = $1`, [b]);
      await transfer(send('25')).expect(201);
      expect(await balance(b, 'cNGN')).toBe('25.000000');
    });

    it.each([
      ['a malformed to_wallet_id', { to_wallet_id: 'nope', source_currency: 'cNGN', amount: '1' }],
      ['a null to_wallet_id', { to_wallet_id: null, source_currency: 'cNGN', amount: '1' }],
      ['a missing to_wallet_id', { source_currency: 'cNGN', amount: '1' }],
      [
        'a null destination_currency',
        { to_wallet_id: 'B', source_currency: 'cNGN', destination_currency: null, amount: '1' },
      ],
      ['a JSON number amount', { to_wallet_id: 'B', source_currency: 'cNGN', amount: 1 }],
      ['a null amount', { to_wallet_id: 'B', source_currency: 'cNGN', amount: null }],
      ['an unknown field', { to_wallet_id: 'B', source_currency: 'cNGN', amount: '1', extra: 1 }],
    ])('rejects %s with 400 VALIDATION_ERROR', async (_label, body) => {
      const payload = JSON.parse(JSON.stringify(body).replace('"B"', JSON.stringify(b))) as object;
      const res = await transfer(payload).expect(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects an unsupported source or destination currency with 400', async () => {
      const src = await transfer(send('1', 'XYZ')).expect(400);
      expect(src.body).toMatchObject({ code: 'UNSUPPORTED_CURRENCY' });
      const dst = await transfer(send('1', 'cNGN', b, 'XYZ')).expect(400);
      expect(dst.body).toMatchObject({ code: 'UNSUPPORTED_CURRENCY' });
    });

    it('rejects an amount over the maximum with 422 AMOUNT_LIMIT_EXCEEDED', async () => {
      const res = await transfer(send('1000000000.000001')).expect(422);
      expect(res.body).toMatchObject({ code: 'AMOUNT_LIMIT_EXCEEDED' });
    });

    it('requires an Idempotency-Key and writes nothing without one', async () => {
      await deposit(a, 'cNGN', '100');
      const res = await transfer(send('10'), null).expect(400);
      expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
      expect(await count('transactions', `type = 'transfer'`)).toBe(0);
    });
  });

  describe('idempotency', () => {
    it('replays the same key and body: one transaction, an identical response', async () => {
      await deposit(a, 'cNGN', '100');

      const first = await transfer(send('10'), 'replay-key').expect(201);
      const second = await transfer(send('10'), 'replay-key').expect(201);

      expect(second.text).toBe(first.text);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.headers['location']).toBe(first.headers['location']);
      expect(await count('transactions', `type = 'transfer'`)).toBe(1);
      expect(await balance(a, 'cNGN')).toBe('90.000000');
      expect(await balance(b, 'cNGN')).toBe('10.000000');
    });

    it('rejects the same key with a different body: 422 IDEMPOTENCY_KEY_REUSED', async () => {
      await deposit(a, 'cNGN', '100');
      await transfer(send('10'), 'reuse-key').expect(201);

      const other = await transfer(send('11'), 'reuse-key').expect(422);
      expect(other.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      const otherRecipient = await t.agent
        .post('/v1/wallets')
        .send({ email: 'c@example.com' })
        .expect(201);
      const toC = await transfer(
        send('10', 'cNGN', otherRecipient.body.id as string),
        'reuse-key',
      ).expect(422);
      expect(toC.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      expect(await count('transactions', `type = 'transfer'`)).toBe(1);
    });

    it('scopes a key to the sender: the same key from another wallet is a separate transfer', async () => {
      await deposit(a, 'cNGN', '100');
      await deposit(b, 'cNGN', '100');
      await transfer(send('10'), 'shared-key', a).expect(201);
      const second = await transfer(send('10', 'cNGN', a), 'shared-key', b).expect(201);
      expect(second.headers['idempotent-replayed']).toBeUndefined();
      expect(await count('transactions', `type = 'transfer'`)).toBe(2);
    });

    it('runs 10 simultaneous identical transfers once and replays the rest', async () => {
      await deposit(a, 'cNGN', '100');
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => transfer(send('10'), 'same-key-race')),
      );
      expect(responses.map((r) => r.status)).toEqual(Array(10).fill(201));
      expect(new Set(responses.map((r) => r.text)).size).toBe(1);
      expect(await count('transactions', `type = 'transfer'`)).toBe(1);
    });
  });
});
