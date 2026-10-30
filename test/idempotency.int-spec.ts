import { AppError } from '../src/common/errors/app-error';
import { createTestApp, type TestApp } from './helpers/create-test-app';

describe('idempotency (on deposits)', () => {
  let t: TestApp;
  let walletId: string;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await t.reset();
    const res = await t.agent.post('/v1/wallets').send({ email: 'idem@example.com' }).expect(201);
    walletId = res.body.id as string;
  });

  const deposit = (body: unknown, key: string | undefined, id = walletId) => {
    const req = t.agent.post(`/v1/wallets/${id}/deposits`);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send(body as object);
  };

  async function count(table: string): Promise<number> {
    const { rows } = await t.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    return rows[0]?.n ?? -1;
  }

  it('rejects a missing key with 400 and writes no transaction row', async () => {
    const res = await deposit({ currency: 'cNGN', amount: '5' }, undefined).expect(400);
    expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    expect(await count('transactions')).toBe(0);
    expect(await count('idempotency_keys')).toBe(0);
  });

  it.each(['has space', 'a'.repeat(256), 'café'])(
    'rejects the invalid key %j with 400',
    async (key) => {
      const res = await deposit({ currency: 'cNGN', amount: '5' }, key).expect(400);
      expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_INVALID' });
      expect(await count('transactions')).toBe(0);
    },
  );

  it('does not store validation errors against the key', async () => {
    await deposit({ currency: 'cNGN', amount: 'abc' }, 'k-invalid-body').expect(400);
    expect(await count('idempotency_keys')).toBe(0);
    // The same key is still free for a corrected request.
    await deposit({ currency: 'cNGN', amount: '5' }, 'k-invalid-body').expect(201);
  });

  it('replays the same key and body: one transaction, identical response, replay header', async () => {
    const first = await deposit({ currency: 'cNGN', amount: '5' }, 'k-replay').expect(201);
    const second = await deposit({ currency: 'cNGN', amount: '5' }, 'k-replay').expect(201);

    expect(await count('transactions')).toBe(1);
    expect(second.text).toBe(first.text);
    expect(second.headers['location']).toBe(first.headers['location']);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.headers['content-type']).toContain('application/json');
  });

  it('treats "10" and "10.0" as the same request, not as key reuse', async () => {
    const first = await deposit({ currency: 'cNGN', amount: '10' }, 'k-format').expect(201);
    const second = await deposit({ currency: 'CNGN', amount: '10.0' }, 'k-format').expect(201);
    expect(second.text).toBe(first.text);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(await count('transactions')).toBe(1);
  });

  it('rejects the same key with a different amount: 422 IDEMPOTENCY_KEY_REUSED', async () => {
    await deposit({ currency: 'cNGN', amount: '10' }, 'k-reuse').expect(201);
    const res = await deposit({ currency: 'cNGN', amount: '11' }, 'k-reuse').expect(422);
    expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await count('transactions')).toBe(1);
  });

  it('runs one transaction and returns identical bodies for 10 simultaneous same-key requests', async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => deposit({ currency: 'USDx', amount: '7' }, 'k-race')),
    );

    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(201));
    expect(await count('transactions')).toBe(1);
    expect(new Set(responses.map((r) => r.text)).size).toBe(1);
    const replayed = responses.filter((r) => r.headers['idempotent-replayed'] === 'true');
    expect(replayed).toHaveLength(9);
  });

  it('scopes keys per wallet: the same key on two wallets creates two transactions', async () => {
    const other = await t.agent
      .post('/v1/wallets')
      .send({ email: 'other@example.com' })
      .expect(201);
    await deposit({ currency: 'cNGN', amount: '5' }, 'k-shared').expect(201);
    const second = await deposit(
      { currency: 'cNGN', amount: '5' },
      'k-shared',
      other.body.id as string,
    );
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBeUndefined();
    expect(await count('transactions')).toBe(2);
  });

  it('executes again once the key has expired', async () => {
    const first = await deposit({ currency: 'cNGN', amount: '5' }, 'k-expire').expect(201);
    await t.pool.query(`UPDATE idempotency_keys SET expires_at = now() - interval '1 second'`);

    const second = await deposit({ currency: 'cNGN', amount: '5' }, 'k-expire').expect(201);

    expect(second.headers['idempotent-replayed']).toBeUndefined();
    expect(second.body.transaction.id).not.toBe(first.body.transaction.id);
    expect(await count('transactions')).toBe(2);
    expect(await count('idempotency_keys')).toBe(1);
  });

  it('releases the key after a 5xx inside the work, so the retry succeeds', async () => {
    jest.spyOn(t.ledger, 'post').mockRejectedValueOnce(new Error('simulated failure'));

    const failed = await deposit({ currency: 'cNGN', amount: '5' }, 'k-5xx').expect(500);
    expect(failed.body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(await count('idempotency_keys')).toBe(0);
    expect(await count('transactions')).toBe(0);

    const retried = await deposit({ currency: 'cNGN', amount: '5' }, 'k-5xx').expect(201);
    expect(retried.headers['idempotent-replayed']).toBeUndefined();
    expect(await count('transactions')).toBe(1);
  });

  it('stores a business rejection against the key and replays it without re-running', async () => {
    const post = jest
      .spyOn(t.ledger, 'post')
      .mockRejectedValueOnce(new AppError('INSUFFICIENT_FUNDS', { detail: 'simulated' }));

    const first = await deposit({ currency: 'cNGN', amount: '5' }, 'k-422').expect(422);
    const second = await deposit({ currency: 'cNGN', amount: '5' }, 'k-422').expect(422);

    expect(first.body).toMatchObject({ code: 'INSUFFICIENT_FUNDS', detail: 'simulated' });
    expect(second.body).toMatchObject({ code: 'INSUFFICIENT_FUNDS', detail: 'simulated' });
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.headers['content-type']).toContain('application/problem+json');
    // The replay reports its own request id.
    expect(second.body.request_id).toBe(second.headers['x-request-id']);
    expect(second.body.request_id).not.toBe(first.body.request_id);
    expect(post).toHaveBeenCalledTimes(1);
    expect(await count('transactions')).toBe(0);
    const stored = await t.pool.query<{ status_code: number }>(
      'SELECT status_code FROM idempotency_keys',
    );
    expect(stored.rows).toEqual([{ status_code: 422 }]);
  });

  it('stores a raw Postgres 22003 raised in the work as a 422 rejection and replays it', async () => {
    const post = jest
      .spyOn(t.ledger, 'post')
      .mockRejectedValueOnce(Object.assign(new Error('out of range'), { code: '22003' }));

    const first = await deposit({ currency: 'cNGN', amount: '5' }, 'k-22003').expect(422);
    const second = await deposit({ currency: 'cNGN', amount: '5' }, 'k-22003').expect(422);

    expect(first.body).toMatchObject({ code: 'AMOUNT_LIMIT_EXCEEDED' });
    expect(second.body).toMatchObject({ code: 'AMOUNT_LIMIT_EXCEEDED' });
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('answers 10 simultaneous same-key requests with different bodies: one wins, the rest are 422 REUSED', async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_unused, i) =>
        deposit({ currency: 'cNGN', amount: String(i + 1) }, 'k-race-diff'),
      ),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    const rejected = responses.filter((r) => r.status === 422);
    expect(rejected).toHaveLength(9);
    for (const r of rejected) expect(r.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await count('transactions')).toBe(1);
  });

  it('undoes partial work when a business rejection happens after some writes', async () => {
    // Rejection thrown after the posting succeeded: the savepoint must roll the posting back.
    const real = t.ledger.post.bind(t.ledger);
    jest.spyOn(t.ledger, 'post').mockImplementationOnce(async (tx, input) => {
      await real(tx, input);
      throw new AppError('WALLET_FROZEN');
    });

    await deposit({ currency: 'cNGN', amount: '5' }, 'k-partial').expect(422);

    expect(await count('transactions')).toBe(0);
    expect(await count('ledger_entries')).toBe(0);
    const balance = await t.pool.query<{ balance: string }>(
      `SELECT balance::text FROM accounts WHERE wallet_id = $1 AND currency = 'cNGN'`,
      [walletId],
    );
    expect(balance.rows[0]?.balance).toBe('0');
  });
});
