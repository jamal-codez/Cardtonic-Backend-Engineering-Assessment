import { createTestApp, type TestApp } from './helpers/create-test-app';

interface Item {
  transaction_id: string;
  type: string;
  currency_out: string | null;
  amount_out: string | null;
  currency_in: string | null;
  amount_in: string | null;
  counterparty_wallet_id: string | null;
  rate: string | null;
  rate_source: string | null;
  created_at: string;
}

describe('transaction history', () => {
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
    await t.reset();
    a = (await t.agent.post('/v1/wallets').send({ email: 'a@example.com' }).expect(201)).body.id;
    b = (await t.agent.post('/v1/wallets').send({ email: 'b@example.com' }).expect(201)).body.id;
  });

  const nextKey = () => `history-key-${++keyCounter}`;

  async function deposit(walletId: string, currency: string, amount: string): Promise<string> {
    const res = await t.agent
      .post(`/v1/wallets/${walletId}/deposits`)
      .set('Idempotency-Key', nextKey())
      .send({ currency, amount })
      .expect(201);
    return res.body.transaction.id as string;
  }

  async function swap(walletId: string, from: string, to: string, amount: string) {
    const res = await t.agent
      .post(`/v1/wallets/${walletId}/swaps`)
      .set('Idempotency-Key', nextKey())
      .send({ from_currency: from, to_currency: to, amount })
      .expect(201);
    return res.body.transaction.id as string;
  }

  async function transfer(
    from: string,
    to: string,
    currency: string,
    amount: string,
    dest?: string,
  ) {
    const res = await t.agent
      .post(`/v1/wallets/${from}/transfers`)
      .set('Idempotency-Key', nextKey())
      .send({
        to_wallet_id: to,
        source_currency: currency,
        ...(dest ? { destination_currency: dest } : {}),
        amount,
      })
      .expect(201);
    return res.body.transaction.id as string;
  }

  const history = (walletId: string, query = '') =>
    t.agent.get(`/v1/wallets/${walletId}/transactions${query}`);

  async function walk(walletId: string, limit: number, onPage?: () => Promise<void>) {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await history(
        walletId,
        `?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
      ).expect(200);
      for (const item of res.body.data as Item[]) seen.push(item.transaction_id);
      cursor = res.body.next_cursor as string | null;
      pages += 1;
      if (pages === 1 && onPage) await onPage();
      expect(pages).toBeLessThan(100);
    } while (cursor);
    return seen;
  }

  /** Three deposits plus a swap give a wallet some history. */
  async function seedHistory(): Promise<{ d1: string; d2: string; d3: string; s1: string }> {
    const d1 = await deposit(a, 'cNGN', '100');
    const d2 = await deposit(a, 'USDx', '50');
    const d3 = await deposit(a, 'cNGN', '25');
    const s1 = await swap(a, 'cNGN', 'USDx', '10');
    return { d1, d2, d3, s1 };
  }

  async function insertActivity(
    id: string,
    transactionId: string,
    createdAt: string,
    walletId = a,
  ): Promise<void> {
    await t.pool.query(
      `INSERT INTO wallet_activity
         (id, wallet_id, transaction_id, activity_type, currency_in, amount_in, created_at)
       VALUES ($1, $2, $3, 'deposit', 'cNGN', 1, $4::timestamptz)`,
      [id, walletId, transactionId, createdAt],
    );
  }

  describe('ordering and content', () => {
    it('lists the newest activity first, with the documented fields', async () => {
      const { d1, d2, d3, s1 } = await seedHistory();

      const res = await history(a).expect(200);

      expect((res.body.data as Item[]).map((i) => i.transaction_id)).toEqual([s1, d3, d2, d1]);
      expect(res.body.next_cursor).toBeNull();
      const [swapItem, , usdDeposit] = res.body.data as Item[];
      expect(swapItem).toEqual({
        transaction_id: s1,
        type: 'swap',
        currency_out: 'cNGN',
        amount_out: '10.000000',
        currency_in: 'USDx',
        amount_in: '0.006666',
        counterparty_wallet_id: null,
        rate: '0.000666666666',
        rate_source: 'static',
        created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      });
      expect(usdDeposit).toMatchObject({
        type: 'deposit',
        currency_out: null,
        amount_out: null,
        currency_in: 'USDx',
        amount_in: '50.000000',
        rate: null,
        rate_source: null,
      });
    });

    it('returns an empty page for a wallet with no activity', async () => {
      const res = await history(a).expect(200);
      expect(res.body).toEqual({ data: [], next_cursor: null });
    });

    it('answers 404 for an unknown wallet and 400 for a malformed id', async () => {
      const unknown = await history('01a18e56-7952-729f-ab7d-cb9426c0fd98').expect(404);
      expect(unknown.body).toMatchObject({ code: 'WALLET_NOT_FOUND' });
      await history('nope').expect(400);
    });

    it('shows the sender transfer_out and the receiver transfer_in, with the rate on cross-currency', async () => {
      await deposit(a, 'cNGN', '1500');
      const id = await transfer(a, b, 'cNGN', '1500', 'cGHS');

      const sent = (await history(a).expect(200)).body.data[0] as Item;
      const received = (await history(b).expect(200)).body.data[0] as Item;

      expect(sent).toMatchObject({
        transaction_id: id,
        type: 'transfer_out',
        currency_out: 'cNGN',
        amount_out: '1500.000000',
        currency_in: null,
        counterparty_wallet_id: b,
        rate: '0.010000000000',
        rate_source: 'static',
      });
      expect(received).toMatchObject({
        transaction_id: id,
        type: 'transfer_in',
        currency_in: 'cGHS',
        amount_in: '15.000000',
        currency_out: null,
        counterparty_wallet_id: a,
        rate: '0.010000000000',
      });
    });

    it('shows no rate for a same-currency transfer', async () => {
      await deposit(a, 'cNGN', '100');
      await transfer(a, b, 'cNGN', '40');
      const item = (await history(b).expect(200)).body.data[0] as Item;
      expect(item).toMatchObject({ type: 'transfer_in', rate: null, rate_source: null });
    });
  });

  describe('pagination', () => {
    it('walking with limit=1 visits every item exactly once, in order, with no gaps', async () => {
      await seedHistory();
      await deposit(a, 'EURx', '1');
      await deposit(a, 'cGHS', '2');
      await transfer(a, b, 'cNGN', '5');
      const everything = (await history(a, '?limit=100').expect(200)).body.data as Item[];
      expect(everything).toHaveLength(7);

      const walked = await walk(a, 1);

      expect(walked).toEqual(everything.map((i) => i.transaction_id));
      expect(new Set(walked).size).toBe(7);
    });

    it('walks with other page sizes too', async () => {
      await seedHistory();
      await deposit(a, 'EURx', '1');
      const everything = (await history(a, '?limit=100').expect(200)).body.data as Item[];
      for (const size of [2, 3, 5]) {
        expect(await walk(a, size)).toEqual(everything.map((i) => i.transaction_id));
      }
    });

    it('gives next_cursor only when another page exists', async () => {
      await seedHistory(); // 4 items
      const exact = await history(a, '?limit=4').expect(200);
      expect(exact.body.next_cursor).toBeNull();
      const more = await history(a, '?limit=3').expect(200);
      expect(typeof more.body.next_cursor).toBe('string');
    });

    it('a deposit inserted mid-walk causes no duplicates and no gaps', async () => {
      await seedHistory();
      const before = (await history(a, '?limit=100').expect(200)).body.data as Item[];

      const walked = await walk(a, 1, async () => {
        await deposit(a, 'cXAF', '9'); // newer than everything already seen
      });

      expect(new Set(walked).size).toBe(walked.length);
      expect(walked).toEqual(before.map((i) => i.transaction_id));
    });

    it('orders activities that share the same created_at by id', async () => {
      const { d1, d2, d3 } = await seedHistory();
      const sameInstant = '2030-01-01T00:00:00Z';
      await insertActivity('00000000-0000-7000-8000-000000000001', d3, sameInstant);
      await insertActivity('00000000-0000-7000-8000-000000000003', d1, sameInstant);
      await insertActivity('00000000-0000-7000-8000-000000000002', d2, sameInstant);

      const all = (await history(a, '?limit=100').expect(200)).body.data as Item[];
      // id descending: ...03 (d1), ...02 (d2), ...01 (d3), before the older real rows.
      expect(all.slice(0, 3).map((i) => i.transaction_id)).toEqual([d1, d2, d3]);

      const walked = await walk(a, 1);
      expect(walked.slice(0, 3)).toEqual([d1, d2, d3]);
      expect(walked).toHaveLength(all.length);
    });

    it('keeps microsecond precision: rows that differ by one microsecond are neither skipped nor repeated', async () => {
      const { d1, d2, d3 } = await seedHistory();
      await insertActivity(
        '00000000-0000-7000-8000-0000000000a1',
        d1,
        '2031-01-01T00:00:00.000001Z',
      );
      await insertActivity(
        '00000000-0000-7000-8000-0000000000a2',
        d2,
        '2031-01-01T00:00:00.000002Z',
      );
      await insertActivity(
        '00000000-0000-7000-8000-0000000000a3',
        d3,
        '2031-01-01T00:00:00.000003Z',
      );

      const all = (await history(a, '?limit=100').expect(200)).body.data as Item[];
      expect(all.slice(0, 3).map((i) => i.transaction_id)).toEqual([d3, d2, d1]);

      const walked = await walk(a, 1);
      // 4 real rows plus 3 planted ones (which reuse existing transaction ids): 7 visits in all.
      expect(walked).toEqual(all.map((i) => i.transaction_id));
      expect(walked).toHaveLength(7);
    });
  });

  describe('filters', () => {
    it('filters by type', async () => {
      await seedHistory();
      await deposit(b, 'cNGN', '100');
      await transfer(b, a, 'cNGN', '10');

      const deposits = (await history(a, '?type=deposit').expect(200)).body.data as Item[];
      expect(deposits).toHaveLength(3);
      expect(deposits.every((i) => i.type === 'deposit')).toBe(true);
      const swaps = (await history(a, '?type=swap').expect(200)).body.data as Item[];
      expect(swaps.map((i) => i.type)).toEqual(['swap']);
      const incoming = (await history(a, '?type=transfer_in').expect(200)).body.data as Item[];
      expect(incoming.map((i) => i.type)).toEqual(['transfer_in']);
      const outgoing = (await history(b, '?type=transfer_out').expect(200)).body.data as Item[];
      expect(outgoing.map((i) => i.type)).toEqual(['transfer_out']);
      expect((await history(a, '?type=transfer_out').expect(200)).body.data).toEqual([]);
    });

    it('filters by currency on either side, and a swap matches both of its currencies', async () => {
      const { s1 } = await seedHistory();

      const ngn = (await history(a, '?currency=cngn').expect(200)).body.data as Item[];
      const usd = (await history(a, '?currency=USDx').expect(200)).body.data as Item[];

      expect(ngn.map((i) => i.type).sort()).toEqual(['deposit', 'deposit', 'swap']);
      expect(usd.map((i) => i.type).sort()).toEqual(['deposit', 'swap']);
      expect(ngn.some((i) => i.transaction_id === s1)).toBe(true);
      expect(usd.some((i) => i.transaction_id === s1)).toBe(true);
      expect((await history(a, '?currency=EURx').expect(200)).body.data).toEqual([]);
    });

    it('combines type, currency and paging', async () => {
      await seedHistory();
      const first = await history(a, '?type=deposit&currency=cNGN&limit=1').expect(200);
      expect(first.body.data).toHaveLength(1);
      const second = await history(
        a,
        `?type=deposit&currency=cNGN&limit=1&cursor=${first.body.next_cursor}`,
      ).expect(200);
      expect(second.body.data).toHaveLength(1);
      expect(second.body.next_cursor).toBeNull();
      expect(second.body.data[0].transaction_id).not.toBe(first.body.data[0].transaction_id);
    });
  });

  describe('validation', () => {
    it.each(['0', '101', '-1', 'abc', '1.5', '1e1', '', '1000', '%201'])(
      'rejects limit=%j with 400 VALIDATION_ERROR',
      async (limit) => {
        const res = await history(a, `?limit=${limit}`).expect(400);
        expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
      },
    );

    it('accepts the limits 1 and 100', async () => {
      await history(a, '?limit=1').expect(200);
      await history(a, '?limit=100').expect(200);
    });

    it('rejects repeated parameters, an unknown type and an unsupported currency', async () => {
      await history(a, '?limit=1&limit=2').expect(400);
      await history(a, '?type=refund').expect(400);
      const res = await history(a, '?currency=XYZ').expect(400);
      expect(res.body).toMatchObject({ code: 'UNSUPPORTED_CURRENCY' });
    });

    it('rejects an unknown query parameter', async () => {
      await history(a, '?sort=asc').expect(400);
    });

    it.each([
      ['garbage', 'zzzz'],
      ['plain text', 'not-a-cursor'],
      ['base64 of non-JSON', Buffer.from('hello').toString('base64url')],
      ['wrong shape', Buffer.from('{"t":"x"}').toString('base64url')],
      [
        'a bad timestamp',
        Buffer.from('{"t":"nope","id":"01a18e56-7952-729f-ab7d-cb9426c0fd98"}').toString(
          'base64url',
        ),
      ],
      [
        'a bad uuid',
        Buffer.from('{"t":"2026-01-01T00:00:00.000000Z","id":"x"}').toString('base64url'),
      ],
      ['standard base64 characters', 'ab+/cd=='],
    ])('rejects a tampered cursor (%s) with 400 INVALID_CURSOR', async (_label, cursor) => {
      const res = await history(a, `?cursor=${encodeURIComponent(cursor)}`).expect(400);
      expect(res.body).toMatchObject({ code: 'INVALID_CURSOR' });
    });

    it('rejects empty and repeated parameters', async () => {
      await history(a, '?cursor=').expect(400);
      await history(a, '?type=').expect(400);
      await history(a, '?currency=').expect(400);
      await history(a, '?currency=cNGN&currency=USDx').expect(400);
      await history(a, '?type=deposit&type=swap').expect(400);
    });

    it('rejects a cursor with a calendar-invalid date as INVALID_CURSOR, not a server error', async () => {
      const cursor = Buffer.from(
        '{"t":"2023-02-31T00:00:00.123456Z","id":"01a18e56-7952-729f-ab7d-cb9426c0fd98"}',
      ).toString('base64url');
      const res = await history(a, `?cursor=${cursor}`).expect(400);
      expect(res.body).toMatchObject({ code: 'INVALID_CURSOR' });
    });

    it('rejects a truncated real cursor', async () => {
      await seedHistory();
      const page = await history(a, '?limit=1').expect(200);
      const cursor = page.body.next_cursor as string;
      const res = await history(a, `?cursor=${cursor.slice(0, cursor.length - 5)}`).expect(400);
      expect(res.body).toMatchObject({ code: 'INVALID_CURSOR' });
    });
  });
});

describe('transaction detail', () => {
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
    await t.reset();
    a = (await t.agent.post('/v1/wallets').send({ email: 'da@example.com' }).expect(201)).body.id;
    b = (await t.agent.post('/v1/wallets').send({ email: 'db@example.com' }).expect(201)).body.id;
  });

  const key = () => `detail-key-${++keyCounter}`;

  const post = async (path: string, body: object) =>
    (await t.agent.post(path).set('Idempotency-Key', key()).send(body).expect(201)).body.transaction
      .id as string;

  const net = (entries: { currency: string; amount: string }[]) => {
    const sums = new Map<string, bigint>();
    for (const e of entries) {
      sums.set(e.currency, (sums.get(e.currency) ?? 0n) + BigInt(e.amount.replace('.', '')));
    }
    return Object.fromEntries([...sums].map(([c, v]) => [c, v.toString()]));
  };

  it('shows a deposit with signed entries that sum to zero', async () => {
    const id = await post(`/v1/wallets/${a}/deposits`, { currency: 'cNGN', amount: '100' });

    const res = await t.agent.get(`/v1/transactions/${id}`).expect(200);

    expect(res.body).toMatchObject({
      id,
      type: 'deposit',
      status: 'completed',
      initiator_wallet_id: a,
      counterparty_wallet_id: null,
      source_currency: 'cNGN',
      source_amount: '100.000000',
      dest_currency: 'cNGN',
      dest_amount: '100.000000',
      rate: null,
      rate_source: null,
      rate_as_of: null,
    });
    expect(res.body.created_at).toMatch(/Z$/);
    expect(res.body.entries).toEqual([
      { account_kind: 'external', wallet_id: null, currency: 'cNGN', amount: '-100.000000' },
      { account_kind: 'user', wallet_id: a, currency: 'cNGN', amount: '100.000000' },
    ]);
    expect(net(res.body.entries)).toEqual({ cNGN: '0' });
  });

  it('shows a swap with four entries, balanced per currency, and the recorded rate', async () => {
    await post(`/v1/wallets/${a}/deposits`, { currency: 'cNGN', amount: '1500' });
    const id = await post(`/v1/wallets/${a}/swaps`, {
      from_currency: 'cNGN',
      to_currency: 'USDx',
      amount: '1500',
    });

    const res = await t.agent.get(`/v1/transactions/${id}`).expect(200);

    expect(res.body).toMatchObject({
      type: 'swap',
      rate: '0.000666666666',
      rate_source: 'static',
      dest_amount: '0.999999',
    });
    expect(res.body.rate_as_of).toMatch(/Z$/);
    expect(res.body.entries).toEqual([
      { account_kind: 'user', wallet_id: a, currency: 'cNGN', amount: '-1500.000000' },
      { account_kind: 'fx_pool', wallet_id: null, currency: 'cNGN', amount: '1500.000000' },
      { account_kind: 'fx_pool', wallet_id: null, currency: 'USDx', amount: '-0.999999' },
      { account_kind: 'user', wallet_id: a, currency: 'USDx', amount: '0.999999' },
    ]);
    expect(net(res.body.entries)).toEqual({ cNGN: '0', USDx: '0' });
  });

  it('shows a transfer with both wallets', async () => {
    await post(`/v1/wallets/${a}/deposits`, { currency: 'cNGN', amount: '100' });
    const id = await post(`/v1/wallets/${a}/transfers`, {
      to_wallet_id: b,
      source_currency: 'cNGN',
      amount: '40',
    });

    const res = await t.agent.get(`/v1/transactions/${id}`).expect(200);

    expect(res.body).toMatchObject({
      type: 'transfer',
      initiator_wallet_id: a,
      counterparty_wallet_id: b,
    });
    expect(res.body.entries).toEqual([
      { account_kind: 'user', wallet_id: a, currency: 'cNGN', amount: '-40.000000' },
      { account_kind: 'user', wallet_id: b, currency: 'cNGN', amount: '40.000000' },
    ]);
    expect(net(res.body.entries)).toEqual({ cNGN: '0' });
  });

  it('answers 404 TRANSACTION_NOT_FOUND for an unknown id and 400 for a malformed one', async () => {
    const unknown = await t.agent
      .get('/v1/transactions/01a18e56-7952-729f-ab7d-cb9426c0fd98')
      .expect(404);
    expect(unknown.body).toMatchObject({ code: 'TRANSACTION_NOT_FOUND' });
    await t.agent.get('/v1/transactions/nope').expect(400);
  });
});
