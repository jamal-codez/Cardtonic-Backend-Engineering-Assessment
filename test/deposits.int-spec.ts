import { createTestApp, type TestApp } from './helpers/create-test-app';

describe('deposits', () => {
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
    await t.reset();
    const res = await t.agent.post('/v1/wallets').send({ email: 'dep@example.com' }).expect(201);
    walletId = res.body.id as string;
  });

  const nextKey = () => `deposit-key-${++keyCounter}`;

  const deposit = (body: unknown, key = nextKey(), id = walletId) =>
    t.agent
      .post(`/v1/wallets/${id}/deposits`)
      .set('Idempotency-Key', key)
      .send(body as object);

  it('credits the balance and returns the transaction and balances after', async () => {
    const res = await deposit({ currency: 'cngn', amount: '1500.5' }).expect(201);

    expect(res.headers['location']).toBe(`/v1/transactions/${res.body.transaction.id}`);
    expect(res.body.transaction).toMatchObject({
      type: 'deposit',
      source_currency: 'cNGN',
      source_amount: '1500.500000',
      dest_currency: 'cNGN',
      dest_amount: '1500.500000',
    });
    expect(res.body.balances_after).toEqual([
      { currency: 'cNGN', amount: '1500.500000' },
      { currency: 'cGHS', amount: '0.000000' },
      { currency: 'cXAF', amount: '0.000000' },
      { currency: 'USDx', amount: '0.000000' },
      { currency: 'EURx', amount: '0.000000' },
    ]);
    expect(res.headers['idempotent-replayed']).toBeUndefined();

    const wallet = await t.agent.get(`/v1/wallets/${walletId}`).expect(200);
    expect(wallet.body.balances[0]).toEqual({ currency: 'cNGN', amount: '1500.500000' });
  });

  it('writes balanced entries, one activity row and keeps stored balances equal to entries', async () => {
    await deposit({ currency: 'USDx', amount: '10' }).expect(201);
    await deposit({ currency: 'USDx', amount: '0.000001' }).expect(201);

    const entries = await t.pool.query<{ currency: string; sum: string; n: number }>(
      'SELECT currency, sum(amount)::text AS sum, count(*)::int AS n FROM ledger_entries GROUP BY currency',
    );
    expect(entries.rows).toEqual([{ currency: 'USDx', sum: '0', n: 4 }]);

    const activity = await t.pool.query<{ activity_type: string; amount_in: string }>(
      'SELECT activity_type, amount_in::text FROM wallet_activity ORDER BY created_at, id',
    );
    expect(activity.rows).toEqual([
      { activity_type: 'deposit', amount_in: '10000000' },
      { activity_type: 'deposit', amount_in: '1' },
    ]);

    const balance = await t.pool.query<{ balance: string; summed: string }>(
      `SELECT a.balance::text, (SELECT sum(amount) FROM ledger_entries e WHERE e.account_id = a.id)::text AS summed
         FROM accounts a WHERE a.wallet_id = $1 AND a.currency = 'USDx'`,
      [walletId],
    );
    expect(balance.rows[0]).toEqual({ balance: '10000001', summed: '10000001' });

    const stored = await t.pool.query<{ idempotency_key: string | null }>(
      'SELECT idempotency_key FROM transactions LIMIT 1',
    );
    expect(stored.rows[0]?.idempotency_key).toMatch(/^deposit-key-/);
  });

  it('rejects an unsupported currency with 400', async () => {
    const res = await deposit({ currency: 'XYZ', amount: '1' }).expect(400);
    expect(res.body).toMatchObject({ code: 'UNSUPPORTED_CURRENCY' });
  });

  it('rejects a JSON number amount with 400', async () => {
    const res = await deposit({ currency: 'cNGN', amount: 10 }).expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it.each(['0', '-1', '1e3', '0x10', ' 5', '.5', '5.', '1.0000001'])(
    'rejects the amount %j with 400',
    async (amount) => {
      const res = await deposit({ currency: 'cNGN', amount }).expect(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    },
  );

  it('rejects an amount over the maximum with 422 AMOUNT_LIMIT_EXCEEDED', async () => {
    await deposit({ currency: 'cNGN', amount: '1000000000' }).expect(201);
    const res = await deposit({ currency: 'cNGN', amount: '1000000000.000001' }).expect(422);
    expect(res.body).toMatchObject({ code: 'AMOUNT_LIMIT_EXCEEDED' });
  });

  it('answers 404 WALLET_NOT_FOUND for an unknown wallet and does not keep the key', async () => {
    const unknown = '01a18e56-7952-729f-ab7d-cb9426c0fd98';
    const res = await deposit({ currency: 'cNGN', amount: '1' }, 'k-unknown', unknown).expect(404);
    expect(res.body).toMatchObject({ code: 'WALLET_NOT_FOUND' });
    const keys = await t.pool.query('SELECT 1 FROM idempotency_keys');
    expect(keys.rowCount).toBe(0);
  });

  it('answers 400 for a malformed wallet id', async () => {
    await deposit({ currency: 'cNGN', amount: '1' }, 'k-bad', 'nope').expect(400);
  });
});
